const axios = require('axios');
var request = require('request');
const nodemailer = require("nodemailer");
const mysql = require("mysql2/promise");

// Set global vailables
WHOLESALE_DISCOUNT=0.65
DISCOUNT=0.5412
MEMBER_MARKUP=0.6574
GUEST_MARKUP=0.8496
DAIRY_MARKUP=0.6
const LL_BASEURL = "https://localline.ca/api/backoffice/v2/"

// For TESTING
const LL_TEST_COMPANY_BASEURL = "https://deck-test.localline.ca";
const LL_TEST_PRICE_LISTS = {
  test1: { id: 5332, markup: MEMBER_MARKUP },
  test2: { id: 5333, markup: MEMBER_MARKUP },
  guest: { id: 4757, markup: GUEST_MARKUP }
};

// Validation
if (isNaN(MEMBER_MARKUP) || isNaN(GUEST_MARKUP) || isNaN(DISCOUNT) || isNaN(WHOLESALE_DISCOUNT)) {
  throw new Error('One or more FFCSA pricing environment variables are missing or invalid. Please check your .env file.');
}

// get access token
async function getAccessToken(p_username, p_password) {
  const { data: auth } = await axios.post(LL_BASEURL + "token", {
    username: p_username,
    password: p_password
  });
  return auth.access;
}

async function sendEmail(emailOptions) {
  console.log('sendEmail function');

  const transporter = nodemailer.createTransport({
    service: "Gmail",
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_ACCESS,
    },
  });

  // ✅ return the Promise so it can be awaited
  try {
    const info = await transporter.sendMail(emailOptions);
    console.log("✅ Email sent:", info.response);
  } catch (error) {
    console.error("❌ Error sending email:", error);
    throw error; // optional: rethrow if you want upstream to handle it
  }
}
// ✅ Secure Database Connection
const db = mysql.createPool({
  host: process.env.DFF_DB_HOST,
  port: process.env.DFF_DB_PORT,
  user: process.env.DFF_DB_USER,
  password: process.env.DFF_DB_PASSWORD,
  database: process.env.DFF_DB_DATABASE,
  waitForConnections: true,
  connectionLimit: 10, // Adjust as needed
  queueLimit: 0
});

// ✅ Test connection once
const isScript = require.main !== module;

if (!isScript) {
  (async () => {
    try {
      const connection = await db.getConnection();
      console.log("✅ Connected to database");
      connection.release();
    } catch (err) {
      console.error("❌ Database connection error on startup:", err);
    }
  })();
}

setInterval(async () => {
  try {
    await db.query('SELECT 1');
  } catch (err) {
    console.error("❌ Connection issue:", err);
  }
}, 30000);


module.exports = {
  db,
  getAccessToken,
  sendEmail,
  GUEST_MARKUP,
  MEMBER_MARKUP,
  DAIRY_MARKUP,
  DISCOUNT,
  WHOLESALE_DISCOUNT,
  LL_BASEURL,
  LL_TEST_PRICE_LISTS
};
