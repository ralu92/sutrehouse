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

// Define the default data structure
const defaultData = { orders: [] };

// In newer lowdb versions, you must pass the default data as the second argument
const db = new Low(new JSONFile('db.json'), defaultData);

async function initDB() {
    try {
        await db.read();
        // The data is already initialized with defaultData if db.json is empty or missing
        console.log("✅ Database initialized.");
    } catch (err) {
        console.error("❌ Database initialization error:", err.message);
    }
}
initDB();

/* ---------------- EMAIL ---------------- */

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL,
        pass: process.env.EMAIL_PASS
    }
});

/* ---------------- EMAIL HELPERS ---------------- */

function formatItems(items) {
    if (!Array.isArray(items)) return "No items listed";
    return items
        .map(i => `${i.name || 'Item'} - ${i.size || 'N/A'} - ${i.fit || 'N/A'} x${i.quantity || 1}`)
        .join("\n");
}

async function sendCustomerEmail(order) {
    try {
        await transporter.sendMail({
            from: process.env.EMAIL,
            to: order.customerEmail,
            subject: "🛍️ Order Confirmation - Sutre House",
            text: `
Thank you for your order!

Order ID: ${order.id}
Total: £${order.amount}

Items:
${formatItems(order.items)}
        `
        });
        console.log(`📧 Confirmation email sent to ${order.customerEmail}`);
    } catch (err) {
        console.error("❌ Error sending customer email:", err.message);
    }
}

async function sendAdminEmail(order) {
    try {
        await transporter.sendMail({
            from: process.env.EMAIL,
            to: process.env.EMAIL,
            subject: "🛒 New Paid Order",
            text: `
NEW ORDER PAID

Order ID: ${order.id}
Total: £${order.amount}

Items:
${formatItems(order.items)}
        `
        });
        console.log("📧 Admin notification email sent.");
    } catch (err) {
        console.error("❌ Error sending admin email:", err.message);
    }
}

/* ---------------- CREATE CHECKOUT ---------------- */

app.post('/create-checkout', async (req, res) => {
    try {
        console.log("📦 Received checkout request:", req.body);

        const { amount, description, items, customerEmail } = req.body;

        if (!amount || !items || !customerEmail) {
            console.warn("⚠️ Missing fields in request");
            return res.status(400).json({
                error: "Missing amount, items or customerEmail"
            });
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

        /* ---------------- SUMUP REQUEST ---------------- */

        const sumupPayload = {
            checkout_reference: orderId,
            amount: Number(amount),
            currency: "GBP",
            merchant_code: process.env.MERCHANT_CODE,
            description: description || "Sutre House Order",
            hosted_checkout: { enabled: true },
            redirect_url: process.env.RETURN_URL,
            return_url: process.env.WEBHOOK_URL
        };

        console.log("📡 Sending request to SumUp...");

        const sumupResponse = await axios.post(
            "https://api.sumup.com/v0.1/checkouts",
            sumupPayload,
            {
                headers: {
                    Authorization: `Bearer ${process.env.SUMUP_API_KEY}`,
                    "Content-Type": "application/json"
                }
            }
        );

        const url = sumupResponse.data?.hosted_checkout_url;

        if (!url) {
            console.error("❌ SumUp did not return a URL:", sumupResponse.data);
            return res.status(500).json({
                error: "SumUp did not return checkout URL",
                details: sumupResponse.data
            });
        }

        console.log("✅ Checkout created successfully:", url);
        return res.json({ url });

    } catch (err) {
        const errorDetail = err.response?.data || err.message;
        console.error("❌ SUMUP ERROR:", JSON.stringify(errorDetail, null, 2));

        return res.status(500).json({
            error: "Checkout failed",
            details: errorDetail
        });
    }
});

/* ---------------- WEBHOOK ---------------- */

app.post('/sumup-webhook', async (req, res) => {
    console.log("🔔 WEBHOOK RECEIVED:", req.body);

    const event = req.body;

    if (event.event_type === "CHECKOUT_STATUS_CHANGED") {
        const checkoutId = event.id;
        
        try {
            const checkoutResponse = await axios.get(
                `https://api.sumup.com/v0.1/checkouts/${checkoutId}`,
                {
                    headers: {
                        Authorization: `Bearer ${process.env.SUMUP_API_KEY}`
                    }
                }
            );
            
            const checkoutData = checkoutResponse.data;
            console.log(`ℹ️ Checkout ${checkoutId} status: ${checkoutData.status}`);
            
            if (checkoutData.status === "PAID") {
                const orderId = checkoutData.checkout_reference;
                
                await db.read();
                const order = db.data.orders.find(o => o.id == orderId);
        
                if (order && order.status !== "PAID") {
                    order.status = "PAID";
                    await db.write();
                    console.log(`✅ Order ${orderId} marked as PAID.`);
        
                    await sendAdminEmail(order);
                    await sendCustomerEmail(order);
                }
            }
        } catch (err) {
            console.error("❌ Error verifying webhook:", err.message);
        }
    }

    res.sendStatus(200);
});

/* ---------------- START SERVER ---------------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});