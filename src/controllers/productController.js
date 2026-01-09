const Product = require("../models/Product");
const utilities = require("../utils/utilities.pricing");
const tokenManager = require("../utils/tokenManager");

//
// ---------- CORE LOGIC FUNCTIONS (Reusable in scripts) ----------
//

/**
 * Fetch product data directly from DB
 */
/**
 * Fetch product data directly from DB, now using normalized category table
 */
async function fetchProductData() {
  console.log('fetching product data');
  const sqlQuery = `
    SELECT
      p.id,
      c.name AS category,
      p.productName,
      p.packageName,
      p.description,
      p.localLineProductID,
      p.visible,
      p.track_inventory,
      p.stock_inventory,
      p.sale,
      p.sale_discount
    FROM pricelist p
    JOIN category c ON p.category_id = c.id
    WHERE p.available_on_ll IS TRUE
    ORDER BY c.name, p.productName`;

  const [results] = await utilities.db.query(sqlQuery);
  return results;
}

/**
 * Update inventory for a given product ID with provided inventory data
 */
async function updateInventoryById(productId, inventoryData) {
  const accessToken = await tokenManager.getValidAccessToken();
  const product = new Product(productId);
  await product.init();

  const updateStatus = await product.updateInventory(inventoryData, accessToken); 

  return updateStatus;
}

/**
 * Update package price for a given product ID
 */
async function updatePackagePriceById(productId) {
  const accessToken = await tokenManager.getValidAccessToken();
  const product = new Product(productId);
  await product.init();
  await product.updatePackagePrice(accessToken);
  return { message: "Package updated successfully" };
}

//
// ---------- EXPRESS CONTROLLERS ----------
//

exports.getProductData = async (req, res) => {
  try {
    const results = await fetchProductData();
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
};

exports.updateInventory = async (req, res) => {
  try {
    const result = await updateInventoryById(req.params.id, req.body);
    res.json(result);
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: err.message });
  }
};

exports.updatePackagePrice = async (req, res) => {
  try {
    const result = await updatePackagePriceById(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};


//
// ---------- EXPORT CORE LOGIC FOR SCRIPTS ----------
//

exports.fetchProductData = fetchProductData;
exports.updateInventoryById = updateInventoryById;
exports.updatePackagePriceById = updatePackagePriceById;
