import nodemailer from "nodemailer";

/**
 * 간단한 이메일 발송 함수
 * @param {Object} options
 * @param {string} options.to - 수신자 이메일
 * @param {string} options.subject - 제목
 * @param {string} options.html - HTML 본문
 * @param {string} [options.text] - 텍스트 본문 (선택)
 */
export async function sendMail({ to, subject, html, text }) {
    try {
        // ✅ 1️⃣ SMTP 설정
        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST, // 예: "smtp.gmail.com"
            port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 465,
            secure: true, // 465 포트면 true
            auth: {
                user: process.env.SMTP_USER, // SMTP 사용자 (이메일)
                pass: process.env.SMTP_PASS, // 앱 비밀번호 또는 토큰
            },
        });

        // ✅ 2️⃣ 이메일 내용 구성
        const mailOptions = {
            from: `"Jelpala" <${process.env.SMTP_USER}>`,
            to,
            subject,
            html,
            text: text || html.replace(/<[^>]+>/g, ""), // HTML을 text로 변환 fallback
        };

        // ✅ 3️⃣ 메일 전송
        const info = await transporter.sendMail(mailOptions);
        console.log(`📨 Email sent: ${info.messageId}`);
        return info;
    } catch (error) {
        console.error("❌ Failed to send email:", error);
        throw error;
    }
}
