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

const db = new Low(new JSONFile('db.json'));

async function initDB() {
    await db.read();
    db.data ||= { orders: [] };
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
    return items
        .map(i => `${i.name} - ${i.size} - ${i.fit} x${i.quantity}`)
        .join("\n");
}

async function sendCustomerEmail(order) {
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
}

async function sendAdminEmail(order) {
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
}

/* ---------------- CREATE CHECKOUT ---------------- */

app.post('/create-checkout', async (req, res) => {
    try {

        const { amount, description, items, customerEmail } = req.body;

        if (!amount || !items || !customerEmail) {
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

        const sumupResponse = await axios.post(
            "https://api.sumup.com/v0.1/checkouts",
            {
                checkout_reference: orderId,
                amount: Number(amount),
                currency: "GBP",
                merchant_code: process.env.MERCHANT_CODE,
                description: description || "Sutre House Order",
                hosted_checkout: { enabled: true },
                redirect_url: process.env.RETURN_URL, // Changed return_url to redirect_url for the success page link
                return_url: process.env.WEBHOOK_URL // Added return_url to receive webhook events
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.SUMUP_API_KEY}`,
                    "Content-Type": "application/json"
                }
            }
        );

        console.log("SUMUP RESPONSE:", sumupResponse.data);

        const url = sumupResponse.data?.hosted_checkout_url;

        if (!url) {
            console.error("NO CHECKOUT URL:", sumupResponse.data);

            return res.status(500).json({
                error: "SumUp did not return checkout URL",
                raw: sumupResponse.data
            });
        }

        return res.json({ url });

    } catch (err) {

        console.error("SUMUP ERROR:");
        console.error(err.response?.data || err.message);

        return res.status(500).json({
            error: "checkout failed",
            details: err.response?.data || err.message
        });
    }
});

/* ---------------- WEBHOOK ---------------- */

app.post('/sumup-webhook', async (req, res) => {

    console.log("WEBHOOK RECEIVED:", req.body);

    const event = req.body;

    // Fixed event_type check. SumUp sends "CHECKOUT_STATUS_CHANGED" for checkouts.
    if (event.event_type === "CHECKOUT_STATUS_CHANGED") {

        // The webhook payload only contains the checkout ID, we need to fetch the checkout details
        // to verify if it's actually PAID.
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
            
            if (checkoutData.status === "PAID") {
                const orderId = checkoutData.checkout_reference;
                
                await db.read();
        
                const order = db.data.orders.find(o => o.id == orderId);
        
                if (order && order.status !== "PAID") {
                    order.status = "PAID";
        
                    await db.write();
        
                    await sendAdminEmail(order);
                    await sendCustomerEmail(order);
                }
            }
        } catch (err) {
            console.error("Error fetching checkout details in webhook:", err.message);
            return res.status(500).send("Error processing webhook");
        }
    }

    res.sendStatus(200);
});

/* ---------------- START SERVER ---------------- */

app.listen(3000, () => {
    console.log("Server running on http://localhost:3000");
});