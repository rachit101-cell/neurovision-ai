// Doctors & hospitals specialist page

document.addEventListener("DOMContentLoaded", () => {
  if (document.getElementById("map-doctors")) {
    initMapBlock({
      mapElementId: "map-doctors",
      listElementId: "hospital-list-doctors",
      sortSelectId: "sort-select-doctors",
      specialistFilterId: "specialist-filter",
    });
  }

  const reportBtn = document.getElementById("download-report-btn-doctors");
  if (reportBtn) {
    reportBtn.addEventListener("click", () => {
      if (typeof generateReportPdf === "function") {
        generateReportPdf();
      }
    });
  }
});

