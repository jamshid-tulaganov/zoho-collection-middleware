#!/usr/bin/env node
/**
 * Fetch PAID + PARTIALLY_PAID invoices from CMP/SMP for LOC-tagged (tagIds=2)
 * people-only carriers registered from October 2025 onward.
 *
 * Output: people-paid-invoices.json  (same shape as carrier-invoices-data.json)
 */

import { writeFileSync } from "fs";
import { refreshSmpToken, fetchAllInvoicesGlobal, indexInvoicesByCarrier, fetchCompanies } from "../src/services/smp.js";

// The 391 carrier IDs (people names, Oct 2025+)
const TARGET_IDS = new Set([
  "5805951","5809299","5805932","5806561","5806097","5807726","5805891","5806591","5807128","5805923",
  "5806421","5806918","5805954","5806334","5806432","5809148","5807066","5806656","5807068","5807081",
  "5807079","5806922","5806920","5807725","5808221","5807338","5807570","5807939","5809045","5808215",
  "5808187","5808356","5808032","5808290","5809859","5808412","5809210","5808138","5808042","5808392",
  "5808135","5808498","5808502","5808926","5808621","5808885","5809327","5808504","5808508","5811118",
  "5808875","5808988","5808849","5809224","5809031","5809095","5809155","5809320","5810523","5809819",
  "5809087","5809677","5809421","5810537","5809393","5809422","5809764","5810110","5810275","5810500",
  "5810921","5809822","5811855","5809970","5810128","5813734","5811773","5810437","5810920","5811115",
  "5811556","5810524","5810426","5810540","5810774","5810683","5810870","5811227","5810853","5811790",
  "5811298","5812206","5812521","5818549","5811437","5811590","5811674","5811558","5811685","5811551",
  "5811683","5811680","5812348","5812043","5818367","5812174","5812189","5820125","5812841","5812298",
  "5812544","5816102","5812421","5813040","5812925","5813276","5814198","5812707","5819278","5813560",
  "5813202","5813318","5813107","5813449","5813186","5813030","5813228","5813187","5813584","5813530",
  "5814058","5814652","5813731","5814061","5813804","5814530","5815370","5814202","5813937","5815540",
  "5816174","5814552","5814452","5814546","5814450","5814544","5814200","5814222","5814745","5814615",
  "5814451","5814507","5815064","5814495","5815330","5814756","5814845","5815532","5814814","5814765",
  "5815188","5816012","5815186","5814932","5817311","5815109","5815110","5815938","5815198","5815096",
  "5815936","5815599","5816046","5817956","5816100","5815534","5815667","5815530","5816024","5815849",
  "5816651","5816162","5822691","5816971","5819383","5816387","5821258","5816161","5816666","5816829",
  "5816770","5816779","5816590","5816932","5817156","5817863","5817275","5817659","5820844","5817325",
  "5817633","5817962","5817695","5818421","5819005","5817568","5817704","5818265","5818293","5820651",
  "5817969","5817735","5818256","5817961","5817805","5818107","5817814","5817721","5817806","5818257",
  "5818429","5818262","5822308","5818356","5822231","5818763","5818833","5818494","5818822","5818355",
  "5818557","5819080","5818515","5820117","5819193","5818756","5819003","5819099","5819759","5819923",
  "5819100","5819109","5819532","5819395","5820778","5825458","5819334","5819398","5820083","5819527",
  "5819390","5820744","5819443","5819601","5819664","5819945","5820463","5819693","5820614","5820752",
  "5819800","5820266","5820655","5821361","5820962","5820267","5825343","5820340","5820268","5823692",
  "5820387","5823619","5820572","5820599","5820386","5822297","5820555","5820931","5820645","5820658",
  "5820647","5820737","5823164","5823383","5821179","5824016","5821358","5824146","5823323","5820984",
  "5821562","5821560","5823296","5821564","5824402","5823357","5822398","5825394","5821823","5822306",
  "5822140","5825630","5822153","5822301","5824014","5824728","5826883","5827421","5822148","5823290",
  "5822367","5828437","5822363","5823534","5822348","5826885","5822783","5823805","5823431","5824699",
  "5823360","5823474","5825369","5823274","5824143","5823291","5823295","5823664","5824157","5824461",
  "5826078","5824121","5824862","5824545","5823922","5823946","5824704","5825256","5824178","5825200",
  "5824743","5826075","5825147","5824849","5824711","5824941","5825173","5825408","5825164","5825395",
  "5826073","5825788","5825378","5825344","5826395","5826066","5825885","5826084","5826881","5827351",
  "5826178","5826272","5826662","5826706","5826661","5827921","5827742","5827531","5826392","5826618",
  "5827074","5826695","5826808","5827532","5826621","5828522","5827572","5827441","5828378","5827373",
  "5827063","5827530","5827826","5828243","5828269","5828758","5827998","5828266","5828395","5828538",
  "5828666",
]);

const PAID_STATUSES = new Set(["PAID", "PARTIALLY_PAID"]);

async function main() {
  console.log("[fetch-people-paid-invoices] Authenticating...");
  await refreshSmpToken();

  console.log("[fetch-people-paid-invoices] Fetching LOC (tag2) and Debtor (tag1) companies...");
  const [locCompanies, debtorCompanies] = await Promise.all([
    fetchCompanies(2),
    fetchCompanies(1),
  ]);
  console.log(`[fetch-people-paid-invoices] LOC companies: ${locCompanies.size}, Debtor companies: ${debtorCompanies.size}`);

  // All carriers with LOC tag (tag2), regardless of debtor tag
  const locTargetIds = [...TARGET_IDS].filter(id => locCompanies.has(id));
  console.log(`[fetch-people-paid-invoices] LOC-tagged people carriers: ${locTargetIds.length} / ${TARGET_IDS.size}`);

  console.log("[fetch-people-paid-invoices] Fetching all invoices globally...");
  const allInvoices = await fetchAllInvoicesGlobal();
  console.log(`[fetch-people-paid-invoices] Total invoices fetched: ${allInvoices.length}`);

  const index = indexInvoicesByCarrier(allInvoices);

  const result = {};
  let totalWithInvoices = 0;

  for (const carrierId of locTargetIds) {
    const all = index.get(carrierId) || [];
    const relevant = all.filter(inv => PAID_STATUSES.has(String(inv.status || "")));

    if (relevant.length === 0) continue;

    totalWithInvoices++;
    const company = locCompanies.get(carrierId) || {};
    const amounts = relevant.map(inv => Number(inv.totalAmount || inv.amount || 0));
    const paidAmounts = relevant
      .filter(inv => inv.status === "PAID")
      .map(inv => Number(inv.totalAmount || inv.amount || 0));
    const highestAmount = Math.max(...amounts);
    const totalPaid = paidAmounts.reduce((s, a) => s + a, 0);

    result[carrierId] = {
      carrierId,
      companyName: company.name || relevant[0]?.companyName || "",
      tag: debtorCompanies.has(carrierId) ? "LOC+Debtor" : "LOC",
      invoiceCount: relevant.length,
      paidCount: paidAmounts.length,
      partiallyPaidCount: relevant.filter(inv => inv.status === "PARTIALLY_PAID").length,
      highestAmount: Math.round(highestAmount * 100) / 100,
      totalPaidAmount: Math.round(totalPaid * 100) / 100,
      invoices: relevant.map(inv => ({
        invoiceNumber: inv.invoiceNumber || inv.id,
        status: inv.status,
        totalAmount: inv.totalAmount || inv.amount || 0,
        paidAmount: inv.paidAmount || 0,
        remainingAmount: inv.remainingAmount || 0,
        createDate: inv.createDate,
        dueDate: inv.dueDate,
        periodFrom: inv.periodFrom || inv.dateFrom,
        periodTo: inv.periodTo || inv.dateTo,
      })),
    };
  }

  const outPath = new URL("../people-paid-invoices.json", import.meta.url).pathname;
  writeFileSync(outPath, JSON.stringify(result, null, 2));

  console.log(`\n[fetch-people-paid-invoices] Done.`);
  console.log(`  LOC-tagged people carriers    : ${locTargetIds.length}`);
  console.log(`  With PAID/PARTIALLY_PAID      : ${totalWithInvoices}`);
  console.log(`  Output written to             : ${outPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
