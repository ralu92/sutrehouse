const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

app.post("/create-checkout", async(req,res)=>{

    try{

        const response = await axios.post(

            "https://api.sumup.com/v0.1/checkouts",

            {
                checkout_reference:
                    "ORDER-" + Date.now(),

                amount:req.body.amount,

                currency:"GBP",

                pay_to_email:
                    "YOUR_SUMUP_EMAIL",

                description:
                    "SutreHouse Order"
            },

            {
                headers:{
                    Authorization:
                        "Bearer YOUR_ACCESS_TOKEN"
                }
            }
        );

        res.json({
            checkout_url:
            response.data.hosted_checkout_url
        });

    }catch(err){

        console.log(err.response?.data);

        res.status(500).send("Error");
    }

});

app.listen(3000);