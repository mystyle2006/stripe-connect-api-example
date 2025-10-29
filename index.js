import express from "express";
import Stripe from "stripe";
import bodyParser from "body-parser";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: "2023-10-16",
});

// ⚡ 일반 JSON 요청
app.use("/api", express.json());

// ⚡ Webhook 전용 raw parser
app.post(
    "/webhook",
    bodyParser.raw({type: "application/json"}),
    async (req, res) => {
        const sig = req.headers["stripe-signature"];
        let event;

        try {
            event = stripe.webhooks.constructEvent(
                req.body,
                sig,
                process.env.WEBHOOK_SECRET
            );
        } catch (err) {
            console.error("❌ Webhook verification failed:", err.message);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        // ✅ 결제 성공 후 트럭회사 정산
        // ⚠ Event: {
        //         id: 'evt_3SNLwdGuoqA1H1PS0p7OKWX4',
        //             object: 'event',
        //             api_version: '2025-09-30.clover',
        //             created: 1761692692,
        //             data: {
        //             object: {
        //                 id: 'pi_3SNLwdGuoqA1H1PS0rCBlw1Q',
        //                     object: 'payment_intent',
        //                     amount: 10000,
        //                     amount_capturable: 0,
        //                     amount_details: [Object],
        //                     amount_received: 10000,
        //                     application: null,
        //                     application_fee_amount: 1500,
        //                     automatic_payment_methods: [Object],
        //                     canceled_at: null,
        //                     cancellation_reason: null,
        //                     capture_method: 'automatic',
        //                     client_secret: 'pi_3SNLwdGuoqA1H1PS0rCBlw1Q_secret_Xc8zgDqTPOI7xxfScZClEU7pt',
        //                     confirmation_method: 'automatic',
        //                     created: 1761692691,
        //                     currency: 'cad',
        //                     customer: 'cus_TJzw6wFkzSnSan',
        //                     description: 'Jelpala Delivery Service',
        //                     excluded_payment_method_types: null,
        //                     last_payment_error: null,
        //                     latest_charge: 'ch_3SNLwdGuoqA1H1PS0xqUE8Sk',
        //                     livemode: false,
        //                     metadata: [Object],
        //                     next_action: null,
        //                     on_behalf_of: 'acct_1SNLmOGuljsmPkGv',
        //                     payment_method: 'pm_1SNLwcGuoqA1H1PS5ZtdFPjK',
        //                     payment_method_configuration_details: [Object],
        //                     payment_method_options: [Object],
        //                     payment_method_types: [Array],
        //                     processing: null,
        //                     receipt_email: null,
        //                     review: null,
        //                     setup_future_usage: null,
        //                     shipping: null,
        //                     source: null,
        //                     statement_descriptor: null,
        //                     statement_descriptor_suffix: null,
        //                     status: 'succeeded',
        //                     transfer_data: [Object],
        //                     transfer_group: 'order_1761692690886'
        //             }
        //         },
        //         livemode: false,
        //             pending_webhooks: 2,
        //             request: {
        //             id: 'req_qweZEAddJPLuwo',
        //                 idempotency_key: 'stripe-node-retry-6dc079a3-8d8f-41f4-905f-a408486fc6da'
        //         },
        //         type: 'payment_intent.succeeded'
        //     }
        if (event.type === "charge.available") {
            console.log(`⚠ Event:`, event)
            const pi = event.data.object;

            const driverAccountId = pi.metadata?.driver_account_id;
            const truckAccountId = pi.metadata?.truck_account_id;

            if (!driverAccountId || !truckAccountId) {
                console.warn("⚠️ Missing account IDs in metadata");
                return res.sendStatus(200);
            }

            const total = pi.amount;
            const truckCompanyShare = Math.round(total * 0.15);

            console.log(`>>> ✅ 트럭회사 내역`)
            console.log(`total:`, total)
            console.log(`truckCompanyShare:`, truckCompanyShare)

            try {
                // 🚛 트럭회사 몫을 젤팔라에서 트럭회사로 송금
                await stripe.transfers.create({
                    amount: truckCompanyShare, // 15 CAD
                    currency: pi.currency,
                    destination: truckAccountId,
                    transfer_group: pi.transfer_group,
                    description: `Trucking company 15% for PI ${pi.id}`,
                });

                console.log("✅ Truck company transfer complete:", transfer.id);
            } catch (e) {
                console.error("❌ Transfer failed:", e.message);
            }
        }

        res.sendStatus(200);
    }
);

app.get("/", (req, res) => {
    res.send("🚀 Jelpala Destination Charge Server (JavaScript)");
});

/**
 * 1️⃣ 드라이버 / 트럭회사 계정 생성
 */
app.post("/api/setup-accounts", async (req, res) => {
    try {
        const driver = await stripe.accounts.create({
            type: "express",
            capabilities: {
                card_payments: {requested: true},
                transfers: {requested: true},
            },
            business_type: "individual",
            metadata: {role: "driver"},
        });

        const driverLink = await stripe.accountLinks.create({
            account: driver.id,
            refresh_url: "https://jelpala.com/onboarding/retry",
            return_url: "https://jelpala.com/onboarding/complete",
            type: "account_onboarding",
        });

        const truck = await stripe.accounts.create({
            type: "express",
            capabilities: {
                card_payments: {requested: true},
                transfers: {requested: true},
            },
            business_type: "company",
            metadata: {role: "truck_company"},
        });

        const truckLink = await stripe.accountLinks.create({
            account: truck.id,
            refresh_url: "https://jelpala.com/onboarding/retry",
            return_url: "https://jelpala.com/onboarding/complete",
            type: "account_onboarding",
        });

        res.json({
            driver_account_id: driver.id,
            driver_link: driverLink,
            truck_account_id: truck.id,
            truck_link: truckLink,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({error: err.message});
    }
});

/**
 * 2️⃣ 고객 결제 (로그인 없이)
 */
app.post("/api/checkout", async (req, res) => {
    const {amount = 10000, currency = "cad", driver_account_id, truck_account_id} = req.body;

    if (!driver_account_id || !truck_account_id) {
        return res.status(400).json({error: "Missing driver/truck account IDs"});
    }

    try {
        // ⚙️ Stripe에서 익명 고객용 Customer 객체 생성 (로그인 없음)
        const customer = await stripe.customers.create({
            description: "Guest Checkout - No Login",
        });

        // 테스트 카드 (Stripe test mode)
        const paymentMethod = await stripe.paymentMethods.create({
            type: "card",
            card: {token: "tok_visa"},
        });

        await stripe.paymentMethods.attach(paymentMethod.id, {customer: customer.id});

        const platformFee = Math.round(amount * 0.3); // 젤팔라 15%

        console.log(`>>> ✅ 결제 내역`)
        console.log(`amount:`, amount)
        console.log(`PlatformFee:`, platformFee)

        // ✅ 드라이버 명의 결제
        const pi = await stripe.paymentIntents.create({
            amount,
            currency,
            customer: customer.id,
            payment_method: paymentMethod.id,
            confirm: true,
            automatic_payment_methods: {enabled: true, allow_redirects: "never"},

            // 핵심: 드라이버 명의 + 드라이버로 바로 정산
            on_behalf_of: driver_account_id,
            transfer_data: {destination: driver_account_id},

            // 젤팔라 수수료
            application_fee_amount: platformFee,

            transfer_group: `order_${Date.now()}`,
            metadata: {
                driver_account_id,
                truck_account_id,
            },
            description: "Jelpala Delivery Service",
        });

        console.log(pi)

        res.json({
            payment_intent_id: pi.id,
            client_secret: pi.client_secret,
            message: "✅ Payment successful!",
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({error: err.message});
    }
});

app.post("/api/save-card", async (req, res) => {
    const customer = await stripe.customers.create({
        description: "Jelpala user",
        email: req.body.email,
    });

    // 고객 카드 등록용 SetupIntent 생성
    const setupIntent = await stripe.setupIntents.create({
        customer: customer.id,
        payment_method_types: ["card"],
    });

    res.json({
        client_secret: setupIntent.client_secret,
        customer_id: customer.id,
    });
});

app.listen(process.env.PORT || 4242, () =>
    console.log(`🌍 Server running on http://localhost:${process.env.PORT || 4242}`)
);
