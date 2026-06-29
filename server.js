require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

/**
 * NOTE: lowdb v4+ is ESM-only. 
 * To maintain CommonJS (require) compatibility and ensure stability, 
 * I've implemented a simple JSON-based database handler.
 */
const DB_PATH = path.join(__dirname, "db.json");

const db = {
    data: { orders: [] },
    async read() {
        try {
            if (fs.existsSync(DB_PATH)) {
                const content = fs.readFileSync(DB_PATH, "utf-8");
                this.data = JSON.parse(content);
            }
        } catch (err) {
            console.error("Error reading database:", err);
        }
    },
    async write() {
        try {
            fs.writeFileSync(DB_PATH, JSON.stringify(this.data, null, 2));
        } catch (err) {
            console.error("Error writing to database:", err);
        }
    }
};

const app = express();

app.use(cors());
app.use(express.json());

/* ---------------- MEMORY STORAGE ---------------- */
const pendingOrders = {};

/**
 * PROMO CODES CONFIGURATION
 * You can manage these in a separate JSON or DB, 
 * but for now, they are defined here.
 */
const PROMO_CODES = {
    "WELCOME10": { type: "PERCENT", value: 10 }, // 10% off
    "SUTRE5": { type: "FIXED", value: 5.00 },    // £5 off
    "MANUS": { type: "PERCENT", value: 100 }     // Free (for testing)
};

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

/* ---------------- VALIDATE PROMO CODE ---------------- */
app.post("/validate-promo", (req, res) => {
    const { code } = req.body;
    const promo = PROMO_CODES[code?.toUpperCase()];

    if (promo) {
        res.json({ valid: true, ...promo });
    } else {
        res.status(404).json({ valid: false, message: "Invalid promo code" });
    }
});

/* ---------------- CREATE CHECKOUT ---------------- */
app.post("/create-checkout", async (req, res) => {
    try {
        const { customerName, customerEmail, amount, items, promoCode } = req.body;

        if (!customerName || !customerEmail || !amount || !items) {
            return res.status(400).json({ error: "Missing required fields: customerName, customerEmail, amount, or items" });
        }

        let finalAmount = parseFloat(amount);
        let discountApplied = 0;

        // Apply Promo Code if provided
        if (promoCode) {
            const promo = PROMO_CODES[promoCode.toUpperCase()];
            if (promo) {
                if (promo.type === "PERCENT") {
                    discountApplied = (finalAmount * promo.value) / 100;
                } else if (promo.type === "FIXED") {
                    discountApplied = promo.value;
                }
                finalAmount = Math.max(0, finalAmount - discountApplied);
            }
        }

        const orderId = uuidv4();

        const order = {
            id: orderId,
            customerName,
            customerEmail,
            originalAmount: parseFloat(amount),
            discount: discountApplied,
            amount: parseFloat(finalAmount.toFixed(2)),
            promoCode: promoCode?.toUpperCase(),
            items,
            status: "PENDING",
            createdAt: new Date().toISOString()
        };

        // Store in memory
        pendingOrders[orderId] = order;

        // Store in DB
        await db.read();
        db.data.orders.push(order);
        await db.write();

        console.log(`Creating SumUp checkout for Order ID: ${orderId}`);

        const sumupPayload = {
            checkout_reference: orderId,
            amount: parseFloat(finalAmount.toFixed(2)),
            currency: "GBP",
            description: "Sutre House Order",
            hosted_checkout: {
                enabled: true
            }
        };

        // Optional but recommended fields
        if (process.env.MERCHANT_CODE) sumupPayload.merchant_code = process.env.MERCHANT_CODE;
        if (process.env.RETURN_URL) sumupPayload.return_url = `${process.env.RETURN_URL}?orderId=${orderId}`;
        if (process.env.EMAIL) sumupPayload.pay_to_email = process.env.EMAIL;

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
            console.error("SumUp Response Error:", response.data);
            throw new Error("No checkout URL returned from SumUp");
        }

        res.json({ url });

    } catch (err) {
        const errorDetail = err.response?.data || err.message;
        console.error("Checkout error details:", JSON.stringify(errorDetail, null, 2));
        
        // Return a more descriptive error if available
        res.status(500).json({ 
            error: "Checkout failed", 
            details: typeof errorDetail === 'object' ? 
                     (errorDetail.message || errorDetail.error_code || JSON.stringify(errorDetail)) : 
                     errorDetail 
        });
    }
});

/* ---------------- SUCCESS ROUTE ---------------- */
app.get("/success", async (req, res) => {
    const { orderId } = req.query;

    if (!orderId) {
        return res.status(400).send("<h1>Missing Order ID</h1>");
    }

    // Fallback to DB if memory is lost
    let order = pendingOrders[orderId];

    if (!order) {
        await db.read();
        order = db.data.orders.find(o => o.id === orderId);
    }

    if (!order) {
        return res.status(404).send("<h1>Order not found or expired</h1>");
    }

    try {
        // Update DB status
        await db.read();
        const dbOrder = db.data.orders.find(o => o.id === orderId);

        if (dbOrder && dbOrder.status !== "PAID") {
            dbOrder.status = "PAID";
            dbOrder.paidAt = new Date().toISOString();
            await db.write();

            // Send admin email
            await transporter.sendMail({
                from: process.env.EMAIL,
                to: process.env.EMAIL,
                subject: "New SutreHouse Order Paid",
                html: generateEmail(order, true)
            }).catch(e => console.error("Admin Email Error:", e.message));

            // Send customer email
            await transporter.sendMail({
                from: process.env.EMAIL,
                to: order.customerEmail,
                subject: "Your SutreHouse Order Confirmation",
                html: generateEmail(order, false)
            }).catch(e => console.error("Customer Email Error:", e.message));
        }

        // Remove from memory
        delete pendingOrders[orderId];

        res.send(`
            <div style="font-family:Arial;text-align:center;padding:50px;">
                <h1 style="color: #4CAF50;">Payment Successful ✅</h1>
                <p>Thank you for your order, <strong>${order.customerName}</strong>.</p>
                <p>Order ID: ${order.id}</p>
                <br>
                <a href="/" style="text-decoration:none; background:#333; color:#fff; padding:10px 20px; border-radius:5px;">Return to shop</a>
            </div>
        `);

    } catch (err) {
        console.error("Success Route Error:", err);
        res.status(500).send("Error processing order completion");
    }
});

/* ---------------- START SERVER ---------------- */
const PORT = process.env.PORT || 3000;

// Initialize DB and then start server
db.read().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`Environment check:`);
        console.log(`- SUMUP_TOKEN: ${process.env.SUMUP_TOKEN ? "✅ Set" : "❌ Missing"}`);
        console.log(`- MERCHANT_CODE: ${process.env.MERCHANT_CODE || "❌ Missing (Optional but recommended)"}`);
        console.log(`- RETURN_URL: ${process.env.RETURN_URL || "❌ Missing"}`);
        console.log(`- EMAIL: ${process.env.EMAIL || "❌ Missing"}`);
    });
});
