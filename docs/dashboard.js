$(document).ready(async function () {
    const dataUrl = "https://raw.githubusercontent.com/jdeck88/ffcsa_scripts/main/localline/data/weekly_kpi.json";

    try {
        const response = await fetch(dataUrl);
        if (!response.ok) throw new Error(`Failed to fetch weekly data: ${response.statusText}`);
        const jsonData = await response.json();

        const weeksData = jsonData.weeks;
        if (!Array.isArray(weeksData) || weeksData.length === 0) {
            throw new Error("Invalid JSON format: Missing 'weeks' array.");
        }

        const totalSalesValues = weeksData.map(week => parseFloat(week.data.totalSales) || 0);
        const totalRevenue = totalSalesValues.reduce((sum, sales) => sum + sales, 0);
        const totalWeeks = weeksData.length;

        const totalCOGS = totalRevenue * 0.25;
        const totalGrossProfit = totalRevenue - totalCOGS;
        const totalOverhead = 1000 * totalWeeks;
        const totalNetProfit = totalGrossProfit - totalOverhead;
        const netProfitMargin = (totalNetProfit / totalRevenue) * 100;

        const kpis = [
            { label: "Revenue", value: totalRevenue },
            { label: "COGS (25%)", value: totalCOGS },
            { label: "Gross Profit", value: totalGrossProfit },
            { label: "Overhead ($1000/week)", value: totalOverhead },
            { label: "Net Profit", value: totalNetProfit },
            { label: "Net Profit Margin", value: `${netProfitMargin.toFixed(1)}%` }
        ];

        // ✅ Add "YTD" column header
        const headerRow = document.getElementById("headerRow");
        const th = document.createElement("th");
        th.textContent = "YTD";
        headerRow.appendChild(th);

        // ✅ Populate table body
        const tableBody = document.getElementById("tableBody");
        kpis.forEach(kpi => {
            const tr = document.createElement("tr");

            const tdLabel = document.createElement("td");
            tdLabel.textContent = kpi.label;
            tr.appendChild(tdLabel);

            const tdValue = document.createElement("td");
            tdValue.textContent = typeof kpi.value === "number" ? `$${kpi.value.toFixed(2)}` : kpi.value;
            tr.appendChild(tdValue);

            tableBody.appendChild(tr);
        });

        // ✅ Initialize DataTable
        $('#weeklyKpiTable').DataTable({
            scrollX: true,
            scrollCollapse: true,
            paging: false,
            ordering: false,
            info: false,
            searching: false,
            fixedColumns: {
                leftColumns: 1
            }
        });

        console.log("✅ YTD KPI data loaded successfully");
    } catch (error) {
        console.error("❌ Error loading KPI data:", error);
    }
});

