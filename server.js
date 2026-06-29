require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
const DB_PATH = path.join(__dirname, "db.json");

/* ---------------- MIDDLEWARE ---------------- */
app.use(cors());
app.use(express.json());

/* ---------------- SIMPLE DB ---------------- */
const db = {
  data: { orders: [] },

  load() {
    if (fs.existsSync(DB_PATH)) {
      this.data = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
    }
  },

  save() {
    fs.writeFileSync(DB_PATH, JSON.stringify(this.data, null, 2));
  }
};

db.load();

/* ---------------- EMAIL ---------------- */
async function sendConfirmationEmail(order) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL,
      pass: process.env.EMAIL_PASS
    }
  });

  await transporter.sendMail({
    from: "SutreHouse <no-reply@sutrehouse.com>",
    to: order.email,
    subject: "Payment Confirmed",
    text: `Your order ${order.id} has been paid successfully.`
  });
}

/* ---------------- CREATE CHECKOUT ---------------- */
app.post("/create-checkout", async (req, res) => {
  try {
    const { amount, email } = req.body;

    const orderId = uuidv4();

    // Save pending order
    const order = {
      id: orderId,
      email,
      amount,
      status: "PENDING",
      createdAt: Date.now()
    };

    db.data.orders.push(order);
    db.save();

    // Create SumUp checkout
    const response = await axios.post(
      "https://api.sumup.com/v0.1/checkouts",
      {
        checkout_reference: orderId,
        amount,
        currency: "GBP",
        description: "SutreHouse Order",
        merchant_code: process.env.SUMUP_MERCHANT_CODE,
        hosted_checkout: {
          enabled: true
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.SUMUP_ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    res.json({
      checkoutId: response.data.id,
      checkoutUrl: response.data.hosted_checkout_url
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Checkout creation failed" });
  }
});

/* ---------------- WEBHOOK (REAL SOURCE OF TRUTH) ---------------- */
app.post("/webhook/sumup", async (req, res) => {
  try {
    const event = req.body;

    if (!event?.event_type) return res.sendStatus(200);

    if (event.event_type !== "checkout.status_changed") {
      return res.sendStatus(200);
    }

    const checkout = event.payload;
    const orderId = checkout.checkout_reference;
    const status = checkout.status;

    const order = db.data.orders.find(o => o.id === orderId);

    if (!order) return res.sendStatus(200);

    // prevent duplicate processing
    if (order.status === "PAID") return res.sendStatus(200);

    if (status === "PAID") {
      order.status = "PAID";
      order.paidAt = new Date().toISOString();

      db.save();

      await sendConfirmationEmail(order);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    return res.sendStatus(500);
  }
});

/* ---------------- HEALTH CHECK ---------------- */
app.get("/", (req, res) => {
  res.send("Server running");
});

/* ---------------- START SERVER ---------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});