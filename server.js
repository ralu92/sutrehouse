require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const nodemailer = require("nodemailer");

const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');

const app = express();

app.use(cors());
app.use(express.json());

/* ---------------- DATABASE ---------------- */
const defaultData = { orders: [] };
const db = new Low(new JSONFile('db.json'), defaultData);

async function initDB() {
    try {
        await db.read();
        console.log("✅ Database initialized.");
    } catch (err) {
        console.error("❌ Database initialization error:", err.message);
    }
}
initDB();

/* ---------------- EMAIL CONFIG ---------------- */
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL,
        pass: process.env.EMAIL_PASS
    }
});

/* ---------------- PROFESSIONAL EMAIL TEMPLATE ---------------- */

function generateEmailHTML(order, isAdmin = false) {
    const itemsHtml = order.items.map(item => `
        <tr>
            <td style="padding: 10px; border-bottom: 1px solid #eee;">
                <strong>${item.name}</strong><br>
                <span style="color: #666; font-size: 12px;">Size: ${item.size} | Fit: ${item.fit}</span>
            </td>
            <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: center;">x${item.quantity}</td>
            <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: right;">£${(item.price * item.quantity).toFixed(2)}</td>
        </tr>
    `).join('');

    const title = isAdmin ? "New Order Received" : "Order Confirmation";
    const subtitle = isAdmin ? "A new paid order has been placed." : "Thank you for your purchase from Sutre House!";

    return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eee; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="margin: 0; color: #333;">SUTRE HOUSE</h1>
            <p style="color: #999; font-size: 14px;">${title}</p>
        </div>

        <p>Hi ${isAdmin ? 'Admin' : 'there'},</p>
        <p>${subtitle}</p>

        <div style="background: #f9f9f9; padding: 15px; margin-bottom: 20px; border-radius: 5px;">
            <p style="margin: 0; font-size: 14px;"><strong>Order ID:</strong> ${order.id}</p>
            <p style="margin: 5px 0 0 0; font-size: 14px;"><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
            <p style="margin: 5px 0 0 0; font-size: 14px;"><strong>Customer:</strong> ${order.customerEmail}</p>
        </div>

        <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
            <thead>
                <tr style="background: #333; color: #fff;">
                    <th style="padding: 10px; text-align: left;">Item</th>
                    <th style="padding: 10px; text-align: center;">Qty</th>
                    <th style="padding: 10px; text-align: right;">Price</th>
                </tr>
            </thead>
            <tbody>
                ${itemsHtml}
            </tbody>
        </table>

        <div style="text-align: right; font-size: 18px;">
            <strong>Total Paid: £${order.amount.toFixed(2)}</strong>
        </div>

        <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #999; text-align: center;">
            <p>Sutre House | www.sutrehouse.com</p>
            <p>If you have any questions, please reply to this email.</p>
        </div>
    </div>
    `;
}

async function sendCustomerEmail(order) {
    try {
        await transporter.sendMail({
            from: `"Sutre House" <${process.env.EMAIL}>`,
            to: order.customerEmail,
            subject: `🛍️ Order Confirmation #${order.id} - Sutre House`,
            html: generateEmailHTML(order, false)
        });
        console.log(`📧 Professional receipt sent to ${order.customerEmail}`);
    } catch (err) {
        console.error("❌ Error sending customer email:", err.message);
    }
}

async function sendAdminEmail(order) {
    try {
        await transporter.sendMail({
            from: `"Sutre House System" <${process.env.EMAIL}>`,
            to: process.env.EMAIL,
            subject: `🛒 NEW PAID ORDER #${order.id}`,
            html: generateEmailHTML(order, true)
        });
        console.log("📧 Admin notification sent.");
    } catch (err) {
        console.error("❌ Error sending admin email:", err.message);
    }
}

/* ---------------- API ENDPOINTS ---------------- */

app.post('/create-checkout', async (req, res) => {
    try {
        const { customerName, customerEmail, amount, items } = req.body;
        const { amount, description, items, customerEmail } = req.body;
        if (!amount || !items || !customerEmail) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const orderId = Date.now().toString();
        await db.read();
        db.data.orders.push({
            id: orderId,
            amount: Number(amount),
            items,
            customerEmail,
            status: "PENDING"
        });
        await db.write();

        const sumupResponse = await axios.post(
            "https://api.sumup.com/v0.1/checkouts",
            {
                checkout_reference: orderId,
                amount: Number(amount),
                currency: "GBP",
                merchant_code: process.env.MERCHANT_CODE,
                description: description || "Sutre House Order",
                hosted_checkout: { enabled: true },
                redirect_url: process.env.RETURN_URL,
                return_url: process.env.WEBHOOK_URL
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.SUMUP_API_KEY}`,
                    "Content-Type": "application/json"
                }
            }
        );

        const url = sumupResponse.data?.hosted_checkout_url;
        if (!url) throw new Error("No checkout URL returned");

        res.json({ url });
    } catch (err) {
        console.error("❌ Checkout Error:", err.response?.data || err.message);
        res.status(500).json({ error: "Checkout failed", details: err.response?.data || err.message });
    }
});

app.post('/sumup-webhook', async (req, res) => {
    const event = req.body;
    if (event.event_type === "CHECKOUT_STATUS_CHANGED") {
        try {
            const checkoutResponse = await axios.get(
                `https://api.sumup.com/v0.1/checkouts/${event.id}`,
                { headers: { Authorization: `Bearer ${process.env.SUMUP_API_KEY}` } }
            );
            
            const checkoutData = checkoutResponse.data;
            if (checkoutData.status === "PAID") {
                await db.read();
                const order = db.data.orders.find(o => o.id == checkoutData.checkout_reference);
        
                if (order && order.status !== "PAID") {
                    order.status = "PAID";
                    await db.write();
                    await sendAdminEmail(order);
                    await sendCustomerEmail(order);
                }
            }
        } catch (err) {
            console.error("❌ Webhook processing error:", err.message);
        }
    }
    res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
