require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const nodemailer = require("nodemailer");
const { Low } = require("lowdb");
const { JSONFile } = require("lowdb/node");
const { v4: uuidv4 } = require("uuid");

const app = express();

app.use(cors());
app.use(express.json());

/* ---------------- DATABASE ---------------- */
const db = new Low(new JSONFile("db.json"), { orders: [] });

async function initDB() {
    await db.read();
    db.data ||= { orders: [] };
}
initDB();

/* ---------------- MEMORY STORAGE ---------------- */
const pendingOrders = {};

/* ---------------- EMAIL SETUP ---------------- */
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL,
        pass: process.env.EMAIL_PASS
    }
});

/* ---------------- EMAIL TEMPLATE ---------------- */
function generateEmail(order, isAdmin = false) {
    return `
        <h2>${isAdmin ? "New Order Received" : "Order Confirmation"}</h2>
        <p><strong>Order ID:</strong> ${order.id}</p>
        <p><strong>Name:</strong> ${order.customerName}</p>
        <p><strong>Email:</strong> ${order.customerEmail}</p>
        <p><strong>Amount:</strong> £${order.amount}</p>
        <pre>${JSON.stringify(order.items, null, 2)}</pre>
    `;
}

/* ---------------- CREATE CHECKOUT ---------------- */
app.post("/create-checkout", async (req, res) => {
    try {
        const { customerName, customerEmail, amount, items } = req.body;

        if (!customerName || !customerEmail || !amount || !items) {
            return res.status(400).json({ error: "Missing fields" });
        }

        const orderId = uuidv4();

        const order = {
            id: orderId,
            customerName,
            customerEmail,
            amount,
            items,
            status: "PENDING"
        };

        pendingOrders[orderId] = order;

        await db.read();
        db.data.orders.push(order);
        await db.write();

        const response = await axios.post(
            "https://api.sumup.com/v0.1/checkouts",
            {
                checkout_reference: orderId,
                amount: Number(amount),
                currency: "GBP",
                description: "Sutre House Order",
                return_url: `${process.env.RETURN_URL}/success?orderId=${orderId}`
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.SUMUP_API_KEY}`,
                    "Content-Type": "application/json"
                }
            }
        );

        const url = response.data?.hosted_checkout_url;

        if (!url) throw new Error("No checkout URL");

        res.json({ url });

    } catch (err) {
        console.error("Checkout error:", err.response?.data || err.message);
        res.status(500).json({ error: "Checkout failed" });
    }
});

/* ---------------- SUCCESS ROUTE ---------------- */
app.get("/success", async (req, res) => {
    const { orderId } = req.query;

    const order = pendingOrders[orderId];

    if (!order) {
        return res.send("<h1>Order not found or expired</h1>");
    }

    try {
        await db.read();
        const dbOrder = db.data.orders.find(o => o.id === orderId);

        if (dbOrder) {
            dbOrder.status = "PAID";
            await db.write();
        }

        // send admin email
        await transporter.sendMail({
            from: process.env.EMAIL,
            to: process.env.EMAIL,
            subject: "New SutreHouse Order Paid",
            html: generateEmail(order, true)
        });

        // send customer email
        await transporter.sendMail({
            from: process.env.EMAIL,
            to: order.customerEmail,
            subject: "Your SutreHouse Order Confirmation",
            html: generateEmail(order, false)
        });

        delete pendingOrders[orderId];

        res.send(`
            <div style="font-family:Arial;text-align:center;padding:50px;">
                <h1>Payment Successful ✅</h1>
                <p>Thank you for your order.</p>
                <a href="/">Return to shop</a>
            </div>
        `);

    } catch (err) {
        console.error(err);
        res.status(500).send("Error processing order");
    }
});

/* ---------------- START SERVER ---------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));