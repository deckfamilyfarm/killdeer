const path = require('path');
const env = process.env.NODE_ENV || 'production';
const envPath = path.resolve(__dirname, `../.env.${env}`);
require('dotenv').config({ path: envPath });
console.log(`✅ Loaded environment: ${env} from ${envPath}`);

const fs = require('fs');
const ExcelJS = require('exceljs');
const utilities = require('../src/utils/utilities.pricing');
const Product = require('../src/models/Product');

async function exportPricelistToExcel() {
  try {
    const [columns] = await utilities.db.execute("SHOW COLUMNS FROM pricelist");
    const booleanColumns = columns
      .filter(col => col.Type.includes("tinyint(1)"))
      .map(col => col.Field);

    const orderedColumnNames = [
      "id", "localLineProductID", "category", "productName", "packageName",
      "retailSalesPrice", "lowest_weight", "highest_weight", "dff_unit_of_measure",
      "wholesalePricePerLb", "ffcsaPurchasePrice", "ffcsaMemberSalesPrice", "ffcsaGuestSalesPrice",
      "num_of_items", "available_on_ll", "description",
      "track_inventory", "stock_inventory", "visible"
    ];

    const formatColumns = {
      "retailSalesPrice": "$#,##0.00",
      "lowest_weight": "0.00",
      "highest_weight": "0.00",
      "wholesalePricePerLb": "$#,##0.00",
      "ffcsaPurchasePrice": "$#,##0.00",
      "ffcsaMemberSalesPrice": "$#,##0.00",
      "ffcsaGuestSalesPrice": "$#,##0.00"
    };

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Pricelist');
    worksheet.addRow(orderedColumnNames);

    const [rows] = await utilities.db.execute('SELECT id FROM pricelist ORDER BY category_id, productName');

    for (const row of rows) {
      const product = new Product(row.id);
      await product.init();

      const data = product.data;
      const pricing = product.pricing;

      const rowData = orderedColumnNames.map(column => {
        if (column === 'wholesalePricePerLb') {return pricing.wholesalePrice;}
        if (column === 'ffcsaPurchasePrice') return pricing.purchasePrice;
        if (column === 'ffcsaMemberSalesPrice') return pricing.memberSalesPrice;
        if (column === 'ffcsaGuestSalesPrice') return pricing.guestSalesPrice;
        if (column === 'retailSalesPrice') return Number(data[column]);
        if (column === 'lowest_weight') return Number(data[column]);
        if (column === 'highest_weight') return Number(data[column]);
        if (booleanColumns.includes(column)) return data[column] === 1 ? "True" : "False";
        return data[column] ?? "";
      });

      worksheet.addRow(rowData);
    }

    orderedColumnNames.forEach((column, index) => {
      if (formatColumns[column]) {
        worksheet.getColumn(index + 1).numFmt = formatColumns[column];
      }
    });

    const outputFile = '../docs/masterPriceList.xlsx';
    await workbook.xlsx.writeFile(outputFile);
    console.log(`✅ Excel file created: ${outputFile}`);
    await utilities.db.end();
    console.log("✅ Database connection closed.");
    process.exit(0);

  } catch (error) {
    console.error('❌ Error exporting data:', error);
    process.exit(1);
  }
}

exportPricelistToExcel();

