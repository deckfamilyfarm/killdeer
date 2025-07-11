const path = require('path');
const fs = require('fs');
const fastCsv = require("fast-csv");

const axios = require("axios");
const utilities = require("../utils/utilities.pricing");

class Product {
    constructor(productId) {
        this.productId = productId;
        this.data = null;
        this.LL_PRICE_LISTS = JSON.parse(process.env.LL_PRICE_LISTS);
        // Replace placeholder strings with actual values
        for (const key in this.LL_PRICE_LISTS) {
            const entry = this.LL_PRICE_LISTS[key];
            if (entry.markup === 'MEMBER_MARKUP') entry.markup = parseFloat(utilities.MEMBER_MARKUP);
            if (entry.markup === 'GUEST_MARKUP') entry.markup = parseFloat(utilities.GUEST_MARKUP);
        }
        this.LL_DAIRY_PRICE_LISTS = JSON.parse(process.env.LL_DAIRY_PRICE_LISTS);
        for (const key in this.LL_DAIRY_PRICE_LISTS) {
            const entry = this.LL_DAIRY_PRICE_LISTS[key];
            if (entry.markup === 'DAIRY_MARKUP') entry.markup = parseFloat(utilities.DAIRY_MARKUP);
        }
    }

    async init() {
        const [rows] = await utilities.db.query("SELECT * FROM pricelist WHERE id = ?", [this.productId]);
        if (rows.length === 0) {
            throw new Error(`Product ID ${this.productId} not found in database`);
        }
        this.data = rows[0];

        // Now that data is loaded, calculate pricing
        this.pricing = this.#calculatePrices();
    }

    static async create(productId) {
        const product = new Product(productId);
        await product.init();
        return product;
    }

    async addToLLPricelist(pricelistID, accessToken) {
        console.log("adding " + this.productId + " to pricelist " + pricelistID)
            const payload = { pricelist_id: pricelistID, product_id: this.productId };
        await axios.post(`${utilities.LL_BASEURL}pricelists/add/`, payload, {
headers: { Authorization: `Bearer ${accessToken}` }
});
}

async updateInventory({ visible, track_inventory, stock_inventory }, accessToken) {
    try {
        const id = this.productId

            const payload = {
                visible,
                track_inventory,
                set_inventory: stock_inventory,
            };

        // ✅ Query product details
        const [results] = await utilities.db.query(
                "SELECT productName, packageName,  localLineProductID FROM pricelist WHERE id = ?",
                [this.productId]
                );

        if (results.length === 0) {
            throw new Error("Product not found");
        }

        const { productName,  packageName, localLineProductID } = results[0];

        // ✅ Perform the database update
        await utilities.db.query(
                "UPDATE pricelist SET visible=?, track_inventory=?, stock_inventory=? WHERE id=?",
                [visible, track_inventory, stock_inventory, this.productId]
                );


        // ✅ Structured response object
        let updateStatus = {
            id,
            productName,
            databaseUpdate: true,
            localLineUpdate: false
        };

        // ✅ Append change to CSV file
        const logFilePath = path.join(__dirname, "../../data/inventory_updates_log.csv");

        if (!fs.existsSync(logFilePath)) {
            fs.writeFileSync(
                    logFilePath,
                    "id,productName,packageName,visible,track_inventory,stock_inventory,timestamp\n",
                    "utf8"
                    );
        }

        const timestamp = new Date().toISOString();

        const logEntry = [
            id,
            productName,
            packageName,
            visible,
            track_inventory,
            stock_inventory,
            timestamp
        ];

        const writableStream = fs.createWriteStream(logFilePath, { flags: "a", encoding: "utf8" });

        fastCsv
            .writeToStream(writableStream, [logEntry], { headers: false, quote: true })
            .on("finish", () => {
                    fs.appendFileSync(logFilePath, "\n");
                    console.log("✅ Data appended to CSV successfully.");
                    })
        .on("error", (err) => console.error("❌ Error writing to CSV file:", err));

        // ✅ Attempt LocalLine API update
        if (this.data.localLineProductID) {
            try {
                let payload = {
visible: visible,
         track_inventory: track_inventory
                };

                if (track_inventory === true || stock_inventory === 0) {
                    payload.set_inventory = Number(stock_inventory);
                }

                if (Object.keys(payload).length > 0) {
                    await axios.patch(`${utilities.LL_BASEURL}products/${this.data.localLineProductID}/`,payload, { headers: { Authorization: `Bearer ${accessToken}` }, });
                    console.log(`✅ LocalLine product ${this.data.localLineProductID} updated:`, payload);
                    updateStatus.localLineUpdate = true;
                }
            } catch (error) {
                utilities.sendEmail({
from: "jdeck88@gmail.com",
to: "jdeck88@gmail.com",
subject: "LocalLine API update failed",
text: `API update failed for ${localLineProductID}`
});
console.error(`❌ LocalLine API update failed for ${localLineProductID}:`, error);
updateStatus.localLineUpdate = false;
}
} else {
    utilities.sendEmail({
from: "jdeck88@gmail.com",
to: "jdeck88@gmail.com",
subject: "LocalLine API update failed",
text: `We do not have a record of this product in LocalLine: ${localLineProductID}`
});

console.error(`❌ No record found in LocalLine for ${localLineProductID}`);
updateStatus.localLineUpdate = false;
}
return updateStatus;

} catch (error) {
    console.error("❌ Error in Product Module:", error);
    throw Error;
}
}

// Update LL Prices
async updatePricelists(accessToken, IS_TESTING) {

    const isDairy = this.data.category_id === 9;
    const priceLists = isDairy ? this.LL_DAIRY_PRICE_LISTS : this.LL_PRICE_LISTS;

    for (const listName in priceLists) {
        const { id, markup } = priceLists[listName];
        if (IS_TESTING) { 
            console.log(`Would update list '${listName}' (ID: ${id}) with markup: ${markup}`);
        } else {
            await this.updateSinglePriceList(id, markup, accessToken);
        }
    }
}

// Run the udpater script
async updateSinglePriceList(priceListID, markupDecimal, accessToken) {

    const productId = this.data.localLineProductID;
    const newBasePrice = this.pricing.purchasePrice;
    // Get the first package 
    // TODO: move this section here to its own function
    try {
        const { data: product } = await axios.get(utilities.LL_BASEURL + "products/"+ productId +"/",
                { headers: { Authorization: `Bearer ${accessToken}` } }
                );
        const firstPackage = product.packages?.[0];
        if (!firstPackage) {
            console.error("❌ No package found for product", productId);
            return;
        }
        const packageId = firstPackage.id;
        const entry = (product.product_price_list_entries || []).find(
                e => e.price_list === priceListID
                );

        if (!entry) {
            const priceListName = Object.keys(this.LL_PRICE_LISTS).find(k => this.LL_PRICE_LISTS[k] === priceListID) || `ID ${priceListID}`;
            console.warn(`⚠️ Product ${product.name} is not on price list "${priceListName}"`);

            const now = new Date();
            const timestamp = now.toLocaleString("en-US", {
year: 'numeric',
month: '2-digit',
day: '2-digit',
hour: 'numeric',
minute: '2-digit',
hour12: true
}).replace(",", "");
const message = `product does not appear in pricelist ${priceListName} (${priceListID})`;
// TODO: restore missing links log
/*
   MISSING_LINKS_LOG.push({
timestamp: timestamp,
product_id: product.id,
product_name: product.name, 
missing_price_list: message
});
 */

return;
}

const priceListEntry = this.generateSinglePriceListEntry(newBasePrice, entry, markupDecimal);
if (!priceListEntry) return;
const payload = {
name: this.data.productName,
      description: this.data.description,
      package_codes_enabled: true,
      packages: [
      {
id: packageId,
    name: this.data.packageName,
    unit_price: parseFloat(newBasePrice).toFixed(2),
    package_price: parseFloat(newBasePrice).toFixed(2),
    package_unit_price: parseFloat(newBasePrice).toFixed(2),
    inventory_per_unit: 1,
    price_list_entries: [priceListEntry],
    package_code: this.data.upc,
      }
      ]
};

//console.log(JSON.stringify(payload, null, 2));
await axios.patch( utilities.LL_BASEURL + "products/"+ productId +"/?expand=vendor",
        payload,
        {
headers: {
Authorization: `Bearer ${accessToken}`,
"Content-Type": "application/json",
Referer: utilities.LL_TEST_COMPANY_BASEURL,
Origin: utilities.LL_TEST_COMPANY_BASEURL
}
}
);

//console.log(`✅ Updated ${product.name} (${productId}) on price list ${priceListID} to base price of $${newBasePrice} with ${(priceListEntry.adjustment_value).toFixed(2)}% markup`);
console.log(`✅ Updated ${product.name} (${productId}) on price list ${priceListID} to base price of $${newBasePrice} with ${(priceListEntry.adjustment_value).toFixed(2)}% markup${this.data.sale ? ' (Sale!)' : ''}`);


} catch (err) {
    console.error(`❌ Update failed for product ${productId}, price list ${priceListID}:`, err.response?.data || err.message);
    //console.error(err)
}
}
// Entry for updating a product on a single pricelist
generateSinglePriceListEntry(basePrice, priceListEntry, markupDecimal) {
    if (!priceListEntry) return null;
    let calculated = parseFloat((basePrice * (1 + markupDecimal)).toFixed(2));
    let adjustment_value = Number((markupDecimal * 100).toFixed(2));
    let strikethrough_display_value = null;

    //const sale = true;
    let on_sale_toggle = false;
    let saleDeductValue = 0

        if (this.data.sale) {
            saleDeductValue = this.data.sale_discount;
            let saleMarkup = markupDecimal - saleDeductValue;
            console.log("Sale! Applying markup of " + saleMarkup.toFixed(2) + "% instead of " + markupDecimal.toFixed(2) + "%")      
                on_sale_toggle = true;
            strikethrough_display_value = calculated;
            calculated = parseFloat((basePrice * (1 + saleMarkup)).toFixed(2));
            adjustment_value = Number((saleMarkup* 100).toFixed(2));
        } 

    return {
adjustment: true,
                adjustment_type: 2,
                adjustment_value: adjustment_value,
                price_list: priceListEntry.price_list,
                checked: true,
                notSubmitted: false,
                edited: false,
                dirty: true,
                product_price_list_entry: priceListEntry.id,
                calculated_value: calculated,
                on_sale: this.data.sale,
                on_sale_toggle: on_sale_toggle,
                max_units_per_order: null,
                strikethrough_display_value: strikethrough_display_value 
    };
}


#calculatePrices() {
    //const DISCOUNT = parseFloat(process.env.DISCOUNT);
    //const MEMBER_MARKUP = parseFloat(process.env.MEMBER_MARKUP);
    //const GUEST_MARKUP = parseFloat(process.env.GUEST_MARKUP);
    const DISCOUNT = parseFloat(utilities.DISCOUNT);
    const WHOLESALE_DISCOUNT = parseFloat(utilities.WHOLESALE_DISCOUNT);
    const MEMBER_MARKUP = parseFloat(utilities.MEMBER_MARKUP);
    const GUEST_MARKUP = parseFloat(utilities.GUEST_MARKUP);

    let ffcsaPurchasePrice = 0;

    let wholesalePrice = this.data.retailSalesPrice * WHOLESALE_DISCOUNT;
    if (this.data.dff_unit_of_measure === 'lbs') {
        const avgWeight = (Number(this.data.highest_weight) + Number(this.data.lowest_weight)) / 2;
        ffcsaPurchasePrice = avgWeight * this.data.retailSalesPrice * DISCOUNT;
    } else if (this.data.dff_unit_of_measure === 'each') {
        ffcsaPurchasePrice = this.data.retailSalesPrice * DISCOUNT;
    } else {
        throw new Error(`Unknown unit of measure: ${this.data.dff_unit_of_measure}`);
    }

    return {
wholesalePrice: Number(wholesalePrice.toFixed(2)),
                    purchasePrice: Number(ffcsaPurchasePrice.toFixed(2)),
                    memberSalesPrice: Number((ffcsaPurchasePrice * (1 + MEMBER_MARKUP)).toFixed(2)),
                    guestSalesPrice: Number((ffcsaPurchasePrice * (1 + GUEST_MARKUP)).toFixed(2)),
                    productID: Number(this.data.localLineProductID)
    };
}
}

module.exports = Product;
