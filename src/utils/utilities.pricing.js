const fs = require('fs');
const path = require('path');
const axios = require('axios');
var request = require('request');
const nodemailer = require("nodemailer");
const mysql = require("mysql2/promise");


// Set global vailables
WHOLESALE_DISCOUNT=0.65
DISCOUNT=0.5412
MEMBER_MARKUP=0.6574
GUEST_MARKUP=0.92
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

async function getAccessToken(p_username, p_password) {
  const url = LL_BASEURL + "token";

  try {
    const response = await axios({
      method: 'post',
      url,
      headers: {
        'Content-Type': 'application/json'
      },
      data: {
        username: p_username,
        password: p_password
      },
      timeout: 10000 // 10 seconds
    });

    return response.data.access;
  } catch (error) {
    console.error('❌ Error getting token');

    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    } else if (error.request) {
      console.error('No response received:', error.request);
    } else {
      console.error('Error message:', error.message);
    }

    throw error;
  }
}
async function sendErrorEmail(error) {
    const callerScript = path.basename(require.main.filename);

    console.log(`[${callerScript}] Error occurred: ${error}`);

    const transporter = nodemailer.createTransport({
        service: "Gmail",
        auth: {
            user: process.env.MAIL_USER,
            pass: process.env.MAIL_ACCESS,
        },
    });

    const emailOptions = {
        from: "jdeck88@gmail.com",
        to: "jdeck88@gmail.com",
        subject: `FFCSA Reports: Error in ${callerScript}`,
        text: `Script: ${callerScript}\n\nError Message:\n${error}`,
    };

    transporter.sendMail(emailOptions, (error, info) => {
        if (error) {
            console.error("Error sending email:", error);
        } else {
            console.log("Email sent:", info.response);
        }
		process.exit(1);
    });
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
	process.exit(1);
  }
}

// obtain "id" value and save
function getRequestID(urlRequest, accessToken) {
    return new Promise((resolve, reject) => {

        // submit download request -- supply returned "access"
        var options = {
            'method': 'GET',
            'url': `${urlRequest}`,
            'headers': {
                'Authorization': `Bearer ${accessToken}`
            }
        };

        request(options, (error, response, body) => {
            if (error) {
                reject(error);
            } else {
                resolve(body);
            }
        });
    });
}

function checkRequestId(id, accessToken) {
    return new Promise((resolve, reject) => {

        var options = {
            'method': 'GET',
            'url': `https://localline.ca/api/backoffice/v2/export/${id}/`,
            'headers': {
                'Authorization': `Bearer ${accessToken}`
            }
        };
        request(options, (error, response, body) => {
            if (error) {
                reject(error);
            } else {
                resolve(body);
            }
        });

    });
}

async function pollStatus(id, accessToken) {
    let status = null;
    let pollingStartTime = Date.now();

    const pollInterval = 5000; // 5 seconds
    const maxPollingTime = 90000; // 1.5 minutes

    while (status !== "COMPLETE") {
        const data = await checkRequestId(id, accessToken);
        status = JSON.parse(data).status;
        console.log(status);

        if (status === "COMPLETE") {
            return JSON.parse(data).file_path
            //return status; // Return the status if it's "COMPLETE"
        }

        if (Date.now() - pollingStartTime >= maxPollingTime) {
            console.error("Status not COMPLETE after 1 minute. Stopping polling.");
            throw new Error("Status not COMPLETE after 1 minute. Stopping polling.")
        }

        await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return ""; // Return an empty string
}

function getPreviousWeek(dateString) {
    const givenDate = new Date(dateString);
    const dayOfWeek = givenDate.getDay();

    // Calculate the difference in days from the given date to the previous Monday
    const daysUntilPreviousMonday = (dayOfWeek === 0 ? 6 : dayOfWeek - 1);

    // Calculate the date for the previous Monday
    const previousMonday = new Date(givenDate);
    previousMonday.setDate(givenDate.getDate() - daysUntilPreviousMonday);

    // Ensure the week starts on a Monday
    previousMonday.setDate(previousMonday.getDate() - 7);

    const previousPreviousSunday = new Date(previousMonday);
    previousPreviousSunday.setDate(previousMonday.getDate() -  1);

    // Calculate the date for the previous Sunday
    const previousSunday = new Date(previousMonday);
    previousSunday.setDate(previousMonday.getDate() + 6);

    return { start: formatDateToYYYYMMDD(previousMonday), end: formatDateToYYYYMMDD(previousSunday), sundaystart: formatDateToYYYYMMDD(previousPreviousSunday) };
}

function getLastMonth() {
    const today = new Date();
    const lastMonth = new Date(today);

    // Set the date to the first day of the current month
    lastMonth.setDate(1);

    // Subtract one day to get the last day of the previous month
    lastMonth.setDate(0);

    const year = lastMonth.getFullYear();
    const month = String(lastMonth.getMonth() + 1).padStart(2, '0');

    const firstDate = `${year}-${month}-01`;
    const lastDate = `${year}-${month}-${String(lastMonth.getDate()).padStart(2, '0')}`;

    return {
        first: firstDate,
        last: lastDate,
    };
}

function getOrderDay() {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    const year = yesterday.getFullYear();
    const month = String(yesterday.getMonth() + 1).padStart(2, '0'); // Months are 0-based
    const day = String(yesterday.getDate()).padStart(2, '0');

    const yesterdayFormatted = `${year}-${month}-${day}`;
    return yesterdayFormatted;
}
function getOrderDayMinusSeven() {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 7);

    const year = yesterday.getFullYear();
    const month = String(yesterday.getMonth() + 1).padStart(2, '0'); // Months are 0-based
    const day = String(yesterday.getDate()).padStart(2, '0');

    const yesterdayFormatted = `${year}-${month}-${day}`;
    return yesterdayFormatted;
}
function getOrderDayMinusFourteen() {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 14);

    const year = yesterday.getFullYear();
    const month = String(yesterday.getMonth() + 1).padStart(2, '0'); // Months are 0-based
    const day = String(yesterday.getDate()).padStart(2, '0');

    const yesterdayFormatted = `${year}-${month}-${day}`;
    return yesterdayFormatted;
}
function getOrderDayMinusTwentyOne() {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 21);

    const year = yesterday.getFullYear();
    const month = String(yesterday.getMonth() + 1).padStart(2, '0'); // Months are 0-based
    const day = String(yesterday.getDate()).padStart(2, '0');

    const yesterdayFormatted = `${year}-${month}-${day}`;
    return yesterdayFormatted;
}
function getYesterday() {
    const today = new Date();
    today.setDate(today.getDate() - 1); // Subtract one day

    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0'); // Months are 0-based
    const day = String(today.getDate()).padStart(2, '0');

    const yesterdayFormatted = `${year}-${month}-${day}`;
    return yesterdayFormatted;
}

function getToday() {
    const today = new Date();

    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0'); // Months are 0-based
    const day = String(today.getDate()).padStart(2, '0');

    const todayFormatted = `${year}-${month}-${day}`;
    return todayFormatted;
}
function getTomorrow() {
    const tomorrow = new Date(new Date());
    const today = new Date();

    tomorrow.setDate(today.getDate() +1);

    const year = tomorrow.getFullYear();
    const month = String(tomorrow.getMonth() + 1).padStart(2, '0'); // Months are 0-based
    const day = String(tomorrow.getDate()).padStart(2, '0');

    const tomorrowFormatted = `${year}-${month}-${day}`;
    return tomorrowFormatted;
}

async function downloadData(file_path, filename) {
    return new Promise((resolve, reject) => {
        const options = {
            method: 'GET',
            url: `${file_path}`,
        };

        const downloadDirectory = 'data'; // Define the subdirectory
        let filePath = '';

        request(options, (error, response, body) => {
            if (error) {
                console.error('Error downloading the file:', error);
                reject(error);
            } else {
                // Create the 'data' directory if it doesn't exist
                if (!fs.existsSync(downloadDirectory)) {
                    fs.mkdirSync(downloadDirectory);
                }
                // Extract the filename from the URL
                const urlParts = options.url.split('/');
                // Determine the file path for the downloaded CSV file
                filePath = path.join(downloadDirectory, filename);
                // Save the CSV content to the specified file
                fs.writeFileSync(filePath, body);
                console.log(`File saved at ${filePath}`);
                resolve(filePath);
            }
        });
    });
}
function formatDate(date) {
    const months = {
        Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
        Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
    };

    // Split the string by space
    const parts = date.split(' ');

    // Extract day, month, and year
    const day = parseInt(parts[0], 10);
    const month = months[parts[1]];
    const year = parseInt(parts[2], 10);

    //const year = date.getFullYear();
    //const month = String(date.getMonth() + 1).padStart(2, '0'); // Months are 0-based
    //const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
function formatDateToYYYYMMDD(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
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
  LL_TEST_PRICE_LISTS,
  getPreviousWeek,
  getOrderDay,
  getOrderDayMinusSeven,
  getOrderDayMinusFourteen,
  getOrderDayMinusTwentyOne,
  getLastMonth,
  getToday,
  getTomorrow,
  getYesterday,
  getRequestID,
  checkRequestId,
  pollStatus,
  downloadData,
  sendErrorEmail,
  formatDate,
  formatDateToYYYYMMDD
};
