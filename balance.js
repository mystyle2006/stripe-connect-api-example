import dotenv from "dotenv";
import Stripe from "stripe";

dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: "2023-10-16",
});

const test = async () => {
    const balance = await stripe.balance.retrieve({
        stripeAccount: 'acct_1SNLmOGuljsmPkGv',
    });
    console.log(balance)
}

test()
