const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();

app.use(cors());
app.use(express.json());

app.post("/create-checkout", async (req, res) => {

    try {

        const response = await axios.post(
            "https://api.sumup.com/v0.1/checkouts",
            {
                checkout_reference: "ORDER-" + Date.now(),
                amount: req.body.amount,
                currency: "GBP",
                pay_to_email: "YOUR_SUMUP_EMAIL",
                description: "SutreHouse Order"
            },
            {
                headers: {
                    Authorization: "Bearer YOUR_ACCESS_TOKEN",
                    "Content-Type": "application/json"
                }
            }
        );

        res.json({
            checkout_url: response.data.hosted_checkout_url
        });

    } catch (err) {
        console.log("SUMUP ERROR:", err.response?.data || err.message);

        res.status(500).json({
            error: "Payment creation failed"
        });
    }

});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});