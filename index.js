import express from "express";
import Stripe from "stripe";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import {sendMail} from "./mail.js";

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
        console.log('>>>req', req.body)
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
 * 카드 등록 setup API
 */
app.post('/api/setup-intent', async (req, res) => {
    // Use an existing Customer ID if this is a returning customer.
    let customer_id = req.body?.customer_id || null;
    if (!customer_id) {
        const customer = await stripe.customers.create({
            description: "Guest Checkout - No Login",
        });
        customer_id = customer.id
    }

    const setupIntent = await stripe.setupIntents.create({
        payment_method_types: ['card'],
        customer: customer_id,
    });

    res.json({
        clientSecret: setupIntent.client_secret,
        customer_id,
    });
});

/* 카드 목록 조회 */
app.post("/api/list-cards", async (req, res) => {
    const {customerId} = req.body;
    const methods = await stripe.paymentMethods.list({
        customer: customerId,
        type: "card",
    });
    res.json(methods.data);
});

/**
 * 2️⃣ 고객 결제 (로그인 없이)
 */
app.post("/api/checkout", async (req, res) => {
    const {
        amount = 10000,
        currency = "cad",
        payment_method_id,
        customer_id,
        driver_account_id,
        truck_account_id
    } = req.body;

    if (!payment_method_id) {
        return res.status(400).json({error: "Missing payment_method_id IDs"});
    }

    if (!customer_id) {
        return res.status(400).json({error: "Missing customer account IDs"});
    }

    if (!driver_account_id || !truck_account_id) {
        return res.status(400).json({error: "Missing driver/truck account IDs"});
    }

    const customer = await stripe.customers.retrieve(customer_id);
    console.log(customer.email); // ⚠️ 없으면 안 보냄

    try {

        await stripe.paymentMethods.attach(payment_method_id, {customer: customer_id});

        const platformFee = Math.round(amount * 0.3); // 젤팔라 15%

        console.log(`>>> ✅ 결제 내역`)
        console.log(`amount:`, amount)
        console.log(`PlatformFee:`, platformFee)

        // 1️⃣ 기존 customer로 invoice 생성
        const invoice = await stripe.invoices.create({
            customer: customer_id,
            auto_advance: false, // 결제는 이미 되었으므로
            collection_method: "send_invoice", // 고객에게 영수증만 전송
            days_until_due: 0, // 즉시 발행 (이미 결제 완료 건)
        });

        // 2️⃣ line items 추가
        await stripe.invoiceItems.create({
            customer: customer_id,
            invoice: invoice.id,
            description: "Delivery Fee",
            amount: amount,
            currency: "cad",
        });

        await stripe.invoiceItems.create({
            customer: customer_id,
            invoice: invoice.id,
            description: "HST (13%)",
            amount: Math.round(amount * 0.13),
            currency: "cad",
        });

        const finalized = await stripe.invoices.finalizeInvoice(invoice.id);

        // ✅ 드라이버 명의 결제
        const pi = await stripe.paymentIntents.create({
            amount,
            currency,
            customer: customer_id,
            payment_method: payment_method_id,
            confirm: true,
            automatic_payment_methods: {enabled: true, allow_redirects: "never"},

            // 핵심: 드라이버 명의 + 드라이버로 바로 정산
            on_behalf_of: driver_account_id,
            transfer_data: {destination: driver_account_id},

            // 젤팔라 수수료
            application_fee_amount: platformFee,

            transfer_group: `order_${Date.now()}`,
            description: "Jelpala Delivery Service",
            metadata: {
                invoice_id: finalized.id,
            }
        });

        /* 실제 결제가 처리되는건아니고 다른곳에서 진행되었다고 표기*/
        await stripe.invoices.pay(finalized.id, { paid_out_of_band: true });

        /* 실제는 메일이 아닌 message를 활용할 수 있음! */
        await sendMail({
            to: "sayyou0918@gmail.com",
            subject: "Your Jelpala Delivery Receipt",
            html: `
    <h2>Thank you for your order!</h2>
    <p>Your invoice has been marked as paid.</p>
    <a href=${finalized.hosted_invoice_url}>View Receipt</a>
  `,
        });

        res.json({
            payment_intent_id: pi.id,
            client_secret: pi.client_secret,
            finalized,
            message: "✅ Payment successful!",
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({error: err.message});
    }
});

app.listen(process.env.PORT || 4242, () =>
    console.log(`🌍 Server running on http://localhost:${process.env.PORT || 4242}`)
);
