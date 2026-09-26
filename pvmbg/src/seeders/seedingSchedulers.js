const seedVolcanicReport = require("./volcanicReportSeeder");

function scheduleSeeder() {
    const delay = (Math.floor(Math.random() * 15) + 1) * 1000;

    setTimeout(async () => {
        try {
            await seedVolcanicReport();
        } catch (error) {
            console.error("Seeder failed:", error);
        }

        scheduleSeeder();
    }, delay);
}

module.exports = scheduleSeeder;