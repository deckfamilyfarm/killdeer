const path = require('path');
const fs = require('fs');
const fastCsv = require("fast-csv");

const axios = require("axios");
const utilities = require("../utils/utilities.pricing");

class Product {
    constructor(productId, isTesting = false) {
        this.productId = productId;
        this.data = null;
        this.IS_TESTING = isTesting;
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
        const [rows] = await utilities.db.query(`
                SELECT pricelist.*, category.name AS category
                FROM pricelist
                LEFT JOIN category ON pricelist.category_id = category.id
                WHERE pricelist.id = ?
                `, [this.productId]);

        if (rows.length === 0) {
            throw new Error(`Product ID ${this.productId} not found in database`);
        }

        const row = rows[0];


        this.data = row;

        this.pricing = this.#calculatePrices();

    }

    static async create(productId, isTesting = false) {
        const product = new Product(productId, isTesting);
        await product.init();
        return product;
    }

    async addToLLPricelist(pricelistID, accessToken) {
        console.log("adding " + this.productId + " to pricelist " + pricelistID);
        const payload = { pricelist_id: pricelistID, product_id: this.productId };


        if (!this.data.available_on_ll) {
            console.log(`Product ${this.data.id} (${this.data.productName}) is not available to update SKIPPING (available_on_ll=false).`);
        } else {
            if (this.IS_TESTING) {
                console.log(`[TEST MODE] Would POST to: ${utilities.LL_BASEURL}pricelists/add/`);
                console.log(payload);
            } else {
                await axios.post(`${utilities.LL_BASEURL}pricelists/add/`, payload, { headers: { Authorization: `Bearer ${accessToken}` } });
            }
        }
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

            const { productName, packageName, localLineProductID } = results[0];

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
                        if (this.IS_TESTING) {
                            console.log(` [TEST MODE] Would patch product product ${this.data.localLineProductID} with:`, payload);
                        } else {
                            await axios.patch(`${utilities.LL_BASEURL}products/${this.data.localLineProductID}/`, payload, { headers: { Authorization: `Bearer ${accessToken}` }, });
                            console.log(`✅ LocalLine product ${this.data.localLineProductID} updated:`, payload);
                            updateStatus.localLineUpdate = true;
                        }
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
async updatePricelists(accessToken) {

    const isDairy = this.data.category_id === 9;
    const priceLists = isDairy ? this.LL_DAIRY_PRICE_LISTS : this.LL_PRICE_LISTS;

    for (const listName in priceLists) {
        const { id, markup } = priceLists[listName];
        await this.updateSinglePriceList(id, markup, accessToken);
    }
}

// Run the udpater script
async updateSinglePriceList(priceListID, markupDecimal, accessToken) {

    const productId = this.data.localLineProductID;
    let newBasePrice = this.pricing.purchasePrice;
    // Get the first package 
    // TODO: move this section here to its own function
    try {
        const { data: product } = await axios.get(utilities.LL_BASEURL + "products/" + productId + "/",
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
newBasePrice = parseFloat(priceListEntry.base_price_used).toFixed(2)

    const payload = {
name: this.data.productName,
      description: this.data.description,
      package_codes_enabled: true,
      packages: [
      {
id: packageId,
    name: this.data.packageName,
    unit_price: newBasePrice,
    package_price: newBasePrice,
    package_unit_price: newBasePrice,
    inventory_per_unit: 1,
    price_list_entries: [priceListEntry],
    package_code: this.data.upc,
      }
      ]
    };


// Update Product Pricing
const base = parseFloat(priceListEntry.base_price_used).toFixed(2);
const markup = priceListEntry.adjustment_value.toFixed(2);
const strike = priceListEntry.strikethrough_display_value ? ` (was $${parseFloat(priceListEntry.strikethrough_display_value).toFixed(2)})` : '';
const price = (parseFloat(base) + (parseFloat(base) * parseFloat(markup) / 100)).toFixed(2);

let message = `${product.name} (${productId}) on price list ${priceListID} $${base} base price $${price} final price ${this.data.sale ? ' (Sale!)' : ''}${strike}`;

if (!this.data.available_on_ll) {
    console.log(`Product ${this.data.id} (${this.data.productName}) is not available to update SKIPPING (available_on_ll=false).`);
} else {
    if (this.IS_TESTING) {
        console.log(`[TEST MODE] Would update ` + message);
    } else {
        await axios.patch(utilities.LL_BASEURL + "products/" + productId + "/?expand=vendor",
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
        console.log(`✅ Update ` + message);
        } }

} catch (err) {
    console.error(`❌ Update failed for product ${productId}, price list ${priceListID}:`, err.response?.data || err.message);
    console.log(err)
}
}

// Entry for updating a product on a single pricelist
generateSinglePriceListEntry(basePrice, priceListEntry, markupDecimal) {
    if (!priceListEntry) return null;
    let calculated = parseFloat((basePrice * (1 + markupDecimal)).toFixed(2));
    let adjustment_value = Number((markupDecimal * 100).toFixed(2));
    let strikethrough_display_value = null;
    let basePriceUsed = basePrice;
    //const sale = true;
    let on_sale_toggle = false;
    let saleDeductValue = 0

        if (this.data.sale) {
            saleDeductValue = this.data.sale_discount; // e.g., 0.25 for 25% off
            const discountPct = (saleDeductValue * 100);

            // Step 1: Regular (pre-discount) final price using unadjusted base price
            const regularFinalPrice = basePrice * (1 + markupDecimal);

            // Step 2: Apply full discount to regular price
            const discountedFinalPrice = regularFinalPrice * (1 - saleDeductValue);

            // Step 3: Calculate adjusted base price that yields discounted price with same markup
            basePriceUsed = discountedFinalPrice / (1 + markupDecimal);

            const saleMarkup = (discountedFinalPrice - basePriceUsed) / basePriceUsed;

            const message = `Calculating ${discountPct}% total discount, splitting basePrice and markup between entities. Effective markup: ${(saleMarkup * 100).toFixed(2)}%`;

            if (this.IS_TESTING) {
                console.log(`[TEST MODE] ${message}`);
            } else {
                console.log(`Sale! ${message}`);
            }

            on_sale_toggle = true;
            strikethrough_display_value = parseFloat(regularFinalPrice.toFixed(2));
            calculated = parseFloat(discountedFinalPrice.toFixed(2));
            adjustment_value = Number((saleMarkup * 100).toFixed(2));
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
                strikethrough_display_value: strikethrough_display_value,
                base_price_used: basePriceUsed
    };
}


#calculatePrices() {
    const DISCOUNT           = parseFloat(utilities.DISCOUNT);
    const WHOLESALE_DISCOUNT = parseFloat(utilities.WHOLESALE_DISCOUNT);
    const MEMBER_MARKUP      = parseFloat(utilities.MEMBER_MARKUP);
    const GUEST_MARKUP       = parseFloat(utilities.GUEST_MARKUP);
    const DAIRY_MARKUP       = parseFloat(utilities.DAIRY_MARKUP);

    const toNum = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : NaN;
    };

    let ffcsaPurchasePrice = 0;
    let retailPackagePrice = 0;

    const retailUnit   = toNum(this.data.retailSalesPrice);
    const uom          = String(this.data.dff_unit_of_measure || '').toLowerCase();
    const highestW     = toNum(this.data.highest_weight);
    const lowestW      = toNum(this.data.lowest_weight);

    const wholesalePrice = retailUnit * WHOLESALE_DISCOUNT;

    if (uom === 'lbs') {
        // average weight; if one side is missing use the other
        let avgWeight;
        if (Number.isFinite(highestW) && Number.isFinite(lowestW)) {
            avgWeight = (highestW + lowestW) / 2;
        } else if (Number.isFinite(highestW)) {
            avgWeight = highestW;
        } else if (Number.isFinite(lowestW)) {
            avgWeight = lowestW;
        } else {
            throw new Error(`Missing weight(s) for pounds-based item id=${this.data.id}`);
        }

        if (!(Number.isFinite(retailUnit) && Number.isFinite(avgWeight) && avgWeight > 0)) {
            throw new Error(`Invalid retail/weight values for item id=${this.data.id}`);
        }

        retailPackagePrice = retailUnit * avgWeight;
        ffcsaPurchasePrice = retailPackagePrice * DISCOUNT;

    } else if (uom === 'each') {
        if (!Number.isFinite(retailUnit)) {
            throw new Error(`Invalid retail price for item id=${this.data.id}`);
        }
        retailPackagePrice = retailUnit;              // per-each already package price
        ffcsaPurchasePrice = retailPackagePrice * DISCOUNT;

    } else {
        throw new Error(`Unknown unit of measure: ${this.data.dff_unit_of_measure}`);
    }

    const memberSalesPrice = ffcsaPurchasePrice * (1 + MEMBER_MARKUP);
    const guestSalesPrice  = ffcsaPurchasePrice * (1 + GUEST_MARKUP);

    // percent over retail (fraction). Guard divide-by-zero.
    const guestPercentOverRetail =
        retailPackagePrice > 0
        ? (guestSalesPrice - retailPackagePrice) / retailPackagePrice
        : null;

    return {
wholesalePrice:        Number(wholesalePrice.toFixed(2)),
                           purchasePrice:         Number(ffcsaPurchasePrice.toFixed(2)),
                           memberSalesPrice:      Number(memberSalesPrice.toFixed(2)),
                           guestSalesPrice:       Number(guestSalesPrice.toFixed(2)),
                           productID:             Number(this.data.localLineProductID),
                           retailPackagePrice:    Number(retailPackagePrice.toFixed(2)),
                           guestPercentOverRetail: guestPercentOverRetail === null
                               ? null
                               : Number(guestPercentOverRetail.toFixed(4)),  // e.g., 0.1250 = 12.50%
    };
}

}

module.exports = Product;
