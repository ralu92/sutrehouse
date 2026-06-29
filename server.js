require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const DB_PATH = path.join(__dirname, "db.json");

/* ---------------- SIMPLE DB ---------------- */
const db = {
    data: { orders: [] },

    async read() {
        try {
            if (fs.existsSync(DB_PATH)) {
                const content = fs.readFileSync(DB_PATH, "utf-8");
                this.data = JSON.parse(content);
            }
        } catch (err) {
            console.error("DB read error:", err);
        }
    },

    async write() {
        try {
            fs.writeFileSync(DB_PATH, JSON.stringify(this.data, null, 2));
        } catch (err) {
            console.error("DB write error:", err);
        }
    }
};

const app = express();
app.use(cors());
app.use(express.json());

/* ---------------- MEMORY ---------------- */
const pendingOrders = {};

/* ---------------- PROMO CODES ---------------- */
const PROMO_CODES = {
    "WELCOME10": { type: "PERCENT", value: 10 },
    "SUTRE5": { type: "FIXED", value: 5 },
    "MANUS": { type: "PERCENT", value: 100 }
};

/* ---------------- EMAIL ---------------- */
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL,
        pass: process.env.EMAIL_PASS
    }
});

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

/* ---------------- PROMO VALIDATION ---------------- */
app.post("/validate-promo", (req, res) => {
    const { code } = req.body;
    const promo = PROMO_CODES[code?.toUpperCase()];

    if (!promo) {
        return res.status(404).json({ valid: false });
    }

    res.json({ valid: true, ...promo });
});

/* ---------------- CREATE CHECKOUT ---------------- */
app.post("/create-checkout", async (req, res) => {
    try {
        const { customerName, customerEmail, amount, items, promoCode } = req.body;

        if (!customerName || !customerEmail || !amount || !items) {
            return res.status(400).json({ error: "Missing fields" });
        }

        let finalAmount = parseFloat(amount);
        let discount = 0;

        if (promoCode) {
            const promo = PROMO_CODES[promoCode.toUpperCase()];
            if (promo) {
                if (promo.type === "PERCENT") {
                    discount = (finalAmount * promo.value) / 100;
                } else {
                    discount = promo.value;
                }
                finalAmount = Math.max(0, finalAmount - discount);
            }
        }

        const orderId = uuidv4();

        const order = {
            id: orderId,
            customerName,
            customerEmail,
            originalAmount: parseFloat(amount),
            discount,
            amount: parseFloat(finalAmount.toFixed(2)),
            promoCode: promoCode?.toUpperCase(),
            items,
            status: "PENDING",
            createdAt: new Date().toISOString()
        };

        pendingOrders[orderId] = order;

        await db.read();
        db.data.orders.push(order);
        await db.write();

        /* FREE ORDER */
        if (finalAmount <= 0) {
            order.status = "PAID";
            order.paidAt = new Date().toISOString();
            await db.write();

            return res.json({
                url: `${process.env.RETURN_URL || "/success"}?orderId=${orderId}`,
                free: true
            });
        }

        const sumupPayload = {
            checkout_reference: orderId,
            amount: parseFloat(finalAmount.toFixed(2)),
            currency: "GBP",
            description: "Sutre House Order",
            hosted_checkout: { enabled: true }
        };

        if (process.env.MERCHANT_CODE) {
            sumupPayload.merchant_code = process.env.MERCHANT_CODE;
        }

        if (process.env.RETURN_URL) {
            sumupPayload.return_url = `${process.env.RETURN_URL}?orderId=${orderId}`;
        }

        if (process.env.EMAIL) {
            sumupPayload.pay_to_email = process.env.EMAIL;
        }

        const response = await axios.post(
            "https://api.sumup.com/v0.1/checkouts",
            sumupPayload,
            {
                headers: {
                    Authorization: `Bearer ${process.env.SUMUP_TOKEN}`,
                    "Content-Type": "application/json"
                }
            }
        );

        const url = response.data?.hosted_checkout_url;

        if (!url) {
            throw new Error("No checkout URL returned");
        }

        res.json({ url });

    } catch (err) {
        console.error("Checkout error:", err.response?.data || err.message);
        res.status(500).json({ error: "Checkout failed" });
    }
});

/* ---------------- SUCCESS PAGE (ONLY UI NOW) ---------------- */
app.get("/success", (req, res) => {
    const { orderId } = req.query;

    res.send(`
        <h1>Payment complete</h1>
        <p>Processing order...</p>

        <script>
         fetch("https://sutrehouse-backend.onrender.com/confirm-payment", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ orderId: "${orderId}" })
            });
        </script>
    `);
});

/* ---------------- CONFIRM PAYMENT (🔥 MAIN FIX) ---------------- */
app.post("/confirm-payment", async (req, res) => {
    const { orderId } = req.body;

    if (!orderId) {
        return res.status(400).json({ error: "Missing orderId" });
    }

    await db.read();
    const order = db.data.orders.find(o => o.id === orderId);

    if (!order) {
        return res.status(404).json({ error: "Order not found" });
    }

    if (order.status === "PAID") {
        return res.json({ ok: true, alreadyProcessed: true });
    }

    order.status = "PAID";
    order.paidAt = new Date().toISOString();
    await db.write();

    try {
        console.log("Sending emails for:", orderId);

        const adminEmail = await transporter.sendMail({
            from: process.env.EMAIL,
            to: process.env.EMAIL,
            subject: "New Order Paid",
            html: generateEmail(order, true)
        });

        console.log("Admin email sent:", adminEmail.messageId);

        const customerEmail = await transporter.sendMail({
            from: process.env.EMAIL,
            to: order.customerEmail,
            subject: "Your Order Confirmation",
            html: generateEmail(order, false)
        });

        console.log("Customer email sent:", customerEmail.messageId);

        delete pendingOrders[orderId];

        return res.json({ ok: true });

    } catch (err) {
        console.error("EMAIL ERROR:", err);
        return res.status(500).json({ error: "Email sending failed" });
    }
});

/* ---------------- START SERVER ---------------- */
const PORT = process.env.PORT || 3000;

db.read().then(() => {
    app.listen(PORT, () => {
        console.log("🚀 Server running on port", PORT);
    });
});