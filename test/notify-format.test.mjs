import assert from "node:assert/strict";
import { test } from "node:test";
import {
  daysBetween,
  distinctTexts,
  escapeMarkdown,
  formatDate,
  formatDateTime,
  isRepeatedIn,
  notificationBody,
  notificationTitle,
  referenceDateOf,
  sortAnnouncements,
  withoutSharedStart,
} from "../scripts/lib/notify-format.mjs";

const URL_A = "https://pvp.giustizia.it/pvp/it/detail_annuncio.page?idAnnuncio=1";
const URL_B = "https://pvp.giustizia.it/pvp/it/detail_annuncio.page?idAnnuncio=2";

function announcement(overrides = {}) {
  return {
    title: "Credito IVA",
    credit_description: "Credito IVA di € 64.867,00",
    asset_descriptions: [],
    court_or_procedure: "Tribunale di BARI - 9/2023",
    publication_date: "2026-11-13",
    sale_type: "Competitiva",
    sale_date: "2026-12-18T12:00",
    offer_deadline: "2026-12-15T09:00",
    base_auction_price: "40.700,00 €",
    official_url: URL_A,
    detail_verified: true,
    ...overrides,
  };
}

const LATEST = { checked_at: "2026-11-14T01:25:42Z", target_date: "2026-11-13", status: "success", error: null };

test("formatDate e formatDateTime usano il formato italiano", () => {
  assert.equal(formatDate("2026-11-13"), "13/11/2026");
  assert.equal(formatDateTime("2027-01-14T11:45"), "gio 14/01/2027 ore 11:45");
  assert.equal(formatDateTime("2026-11-16"), "lun 16/11/2026");
  assert.equal(formatDateTime("data da definire"), "data da definire");
  assert.equal(formatDateTime(null), null);
});

test("daysBetween conta i giorni di calendario ignorando l'ora", () => {
  assert.equal(daysBetween("2026-11-14", "2026-11-26T12:00"), 12);
  assert.equal(daysBetween("2026-12-31", "2027-01-01T00:05"), 1);
  assert.equal(daysBetween("2026-11-14", "2026-11-10"), -4);
  assert.equal(daysBetween("2026-11-14", null), null);
});

test("referenceDateOf usa la data italiana del controllo", () => {
  // Le 23:30 UTC sono già il giorno dopo in Italia.
  assert.equal(referenceDateOf({ checked_at: "2026-11-13T23:30:00Z" }), "2026-11-14");
  assert.equal(referenceDateOf({ target_date: "2026-11-13" }), "2026-11-13");
});

test("escapeMarkdown neutralizza sintassi Markdown, menzioni e riferimenti a issue", () => {
  assert.equal(escapeMarkdown("a _ b * c | d <e>"), "a \\_ b \\* c \\| d \\<e\\>");
  assert.equal(escapeMarkdown("1. Primo lotto"), "1\\. Primo lotto");
  assert.equal(escapeMarkdown("# Titolo"), "\\# Titolo");
  assert.equal(escapeMarkdown("- voce"), "\\- voce");
  assert.equal(escapeMarkdown("100% QUOTE"), "100% QUOTE");
  assert.equal(escapeMarkdown("vedi @mario e #12"), "vedi @\u200bmario e #\u200b12");
  // Gli indirizzi email restano intatti.
  assert.equal(escapeMarkdown("pec info@legamail.it"), "pec info@legamail.it");
});

test("isRepeatedIn tollera varianti minime ma non cifre diverse", () => {
  assert.equal(
    isRepeatedIn("Crediti (cod. 7718) - 230331094547638210000001.", "Crediti (cod. 7718) - identificativo 230331094547638210000001. Altro testo"),
    true,
  );
  assert.equal(isRepeatedIn("Crediti cod. 7719 identificativo 111", "Crediti cod. 7719 identificativo 222"), false);
  assert.equal(
    isRepeatedIn(
      "100% QUOTE DI PARTECIPAZIONE DELLA IMMOBILIARE INVESDTMENTI INDUSTRIALI SRL UNIPERSONALE",
      "100% QUOTE DI PARTECIPAZIONE DELLA IMMOBILIARE INVESTMENTI INDUSTRIALI SRL UNIPERSONALE",
    ),
    true,
  );
  assert.equal(isRepeatedIn("Titoli PAC", "N. 1 Titolo Ordinario numero 5"), false);
  // Una o due parole diverse sono informazione nuova, non un refuso.
  assert.equal(
    isRepeatedIn(
      "Documentazione nella VDR al link https://attiva.asteannunci.it previa registrazione",
      "Documentazione nella VDR al link https://trasformazioneterritoriale.asteannunci.it previa registrazione",
    ),
    false,
  );
  assert.equal(isRepeatedIn("Crediti cedibili solo a soggetti qualificati", "Crediti cedibili a soggetti"), false);
  // Parole simili ma di senso diverso non sono refusi, e più di un refuso non è tollerato.
  assert.equal(
    isRepeatedIn("credito ceduto direttamente e diviso", "credito venduto indirettamente e indiviso"),
    false,
  );
  assert.equal(
    isRepeatedIn("crediti fiscali traciabili e cedibbili", "crediti fiscali tracciabili e cedibili"),
    false,
  );
  // Le stesse parole in ordine diverso possono dire il contrario.
  assert.equal(isRepeatedIn("credito non cedibile e tracciabile", "credito cedibile e non tracciabile"), false);
  // L'ultima parola spezzata conta come ripetizione solo in un testo troncato dal PVP (circa 500 caratteri).
  const filler = "credito fiscale ".repeat(30);
  assert.equal(isRepeatedIn(`${filler}operazione esente da IV`, `${filler}operazione esente da IVA ai sensi di legge`), true);
  assert.equal(isRepeatedIn("operazione esente da IV", "operazione esente da IVA ai sensi di legge"), false);
  assert.equal(isRepeatedIn("Credito verso la società Alfa", "Credito verso la società Alfabeta"), false);
});

test("distinctTexts elimina le ripetizioni tra descrizione e beni", () => {
  assert.deepEqual(
    distinctTexts(announcement({ asset_descriptions: ["Credito IVA di € 64.867,00"] })),
    { description: "Credito IVA di € 64.867,00", assets: [] },
  );
  // Il bene più completo sostituisce la descrizione troncata.
  assert.deepEqual(
    distinctTexts(
      announcement({
        credit_description: "Crediti fiscali per € 97.727,50 riferiti al 2026",
        asset_descriptions: ["Crediti fiscali tracciabili per € 97.727,50 riferiti al 2026 cedibili a chiunque"],
      }),
    ),
    { description: null, assets: ["Crediti fiscali tracciabili per € 97.727,50 riferiti al 2026 cedibili a chiunque"] },
  );
  // Testi diversi restano entrambi; i beni doppi compaiono una volta.
  assert.deepEqual(
    distinctTexts(
      announcement({ credit_description: "Titoli PAC", asset_descriptions: ["N. 1 Titolo 885", "N. 1 Titolo 885", "N. 1 Titolo 886"] }),
    ),
    { description: "Titoli PAC", assets: ["N. 1 Titolo 885", "N. 1 Titolo 886"] },
  );
});

test("withoutSharedStart mostra solo il finale nuovo di un bene", () => {
  const start = "LOTTO 10: credito d’imposta cod. tributo 7716 – non tracciabile – rata annualità 2032 – valore nominale € 1.192,60.";
  assert.equal(
    withoutSharedStart(`${start} Vendita competitiva telematica`, `${start} Possono partecipare solo i soggetti abilitati`),
    "… Vendita competitiva telematica",
  );
  // Un inizio in comune breve non basta.
  assert.equal(withoutSharedStart("Titoli PAC ordinari", "Titoli PAC speciali"), "Titoli PAC ordinari");
  assert.deepEqual(
    distinctTexts(
      announcement({
        credit_description: `${start} Possono partecipare solo i soggetti abilitati`,
        asset_descriptions: [`${start} Vendita competitiva telematica sui portali 123`],
      }),
    ),
    { description: `${start} Possono partecipare solo i soggetti abilitati`, assets: ["… Vendita competitiva telematica sui portali 123"] },
  );
});

test("sortAnnouncements ordina per scadenza, procedura e prezzo decrescente", () => {
  const sorted = sortAnnouncements([
    announcement({ official_url: "senza-date", offer_deadline: null, sale_date: null }),
    announcement({ official_url: "tardi", offer_deadline: "2027-01-14T11:45" }),
    announcement({ official_url: "piccolo", offer_deadline: "2026-11-26T12:00", base_auction_price: "681,00 €" }),
    announcement({ official_url: "grande", offer_deadline: "2026-11-26T12:00", base_auction_price: "1.378.035,44 €" }),
    announcement({ official_url: "solo-vendita", offer_deadline: null, sale_date: "2026-11-20" }),
  ]);
  assert.deepEqual(
    sorted.map((item) => item.official_url),
    ["solo-vendita", "grande", "piccolo", "tardi", "senza-date"],
  );
});

test("notificationTitle riporta numero, data e prima scadenza", () => {
  assert.equal(
    notificationTitle(LATEST, [announcement(), announcement({ offer_deadline: "2026-11-26T12:00" })]),
    "PVP: 2 nuovi annunci del 13/11/2026 – prima scadenza offerte 26/11/2026",
  );
  assert.equal(
    notificationTitle(LATEST, [announcement({ offer_deadline: null })]),
    "PVP: 1 nuovo annuncio del 13/11/2026",
  );
});

test("notificationBody: riepilogo, schede ordinate e nessuna ripetizione", () => {
  const body = notificationBody(LATEST, [
    announcement(),
    announcement({
      official_url: URL_B,
      credit_description: "Titoli PAC | lotto _1_",
      asset_descriptions: ["Titoli PAC", "N. 1 Titolo Ordinario 885"],
      court_or_procedure: "Tribunale di BENEVENTO - 532/2026",
      offer_deadline: "2026-11-18T12:00",
      sale_date: "2026-11-18T15:00",
      base_auction_price: "36,40 €",
    }),
  ]);

  assert.match(body, /^\*\*2 nuovi annunci\*\* pubblicati sul PVP il 13\/11\/2026/);
  assert.ok(body.includes("| # | Prezzo base | Termine offerte | Procedura | Oggetto |"));
  assert.ok(
    body.includes(`| 1 | 36,40 € | 18/11/2026 | Tribunale di BENEVENTO - 532/2026 | [Titoli PAC \\| lotto \\_1\\_](${URL_B}) |`),
  );
  // La scadenza più vicina viene prima ed è evidenziata.
  assert.ok(body.indexOf("### 1. 36,40 € · Tribunale di BENEVENTO") < body.indexOf("### 2. 40.700,00 € · Tribunale di BARI"));
  assert.ok(body.includes("- ⏰ **Termine offerte:** mer 18/11/2026 ore 12:00 (tra 4 giorni)"));
  assert.ok(body.includes("- **Termine offerte:** mar 15/12/2026 ore 09:00 (tra 31 giorni)"));
  assert.ok(body.includes("- **Vendita:** ven 18/12/2026 ore 12:00 · Competitiva"));
  assert.ok(body.includes("**Dettaglio del bene:** N. 1 Titolo Ordinario 885"));
  // Senza termine offerte la colonna resta vuota: la data di vendita non è una scadenza.
  const noDeadline = notificationBody(LATEST, [
    announcement(),
    announcement({ official_url: URL_B, offer_deadline: null, sale_date: "2026-11-20T10:00" }),
  ]);
  assert.ok(noDeadline.includes("| 1 | 40.700,00 € | – | Tribunale di BARI - 9/2023 |"));
  assert.equal(body.match(/Credito IVA di € 64\.867,00/g).length, 2); // riepilogo + scheda
  assert.ok(!body.includes("⚠️"));
  // Ogni riga della tabella ha lo stesso numero di colonne.
  for (const row of body.split("\n").filter((line) => line.startsWith("|"))) {
    assert.equal(row.replace(/\\\|/g, "").split("|").length, 7, row);
  }
});

test("notificationBody: un solo annuncio, controllo parziale e dettaglio non verificato", () => {
  const body = notificationBody(
    { ...LATEST, status: "partial", error: "Elenco anomalo" },
    [announcement({ detail_verified: false, offer_deadline: null, sale_type: null, sale_date: null })],
  );
  assert.match(body, /^\*\*1 nuovo annuncio\*\* pubblicato sul PVP il 13\/11\/2026\./);
  assert.ok(body.includes("> ⚠️ Controllo non completo (stato `partial`): Elenco anomalo. Potrebbero mancare annunci."));
  assert.ok(!body.includes("| # |"));
  assert.ok(!body.includes("Termine offerte"));
  assert.ok(!body.includes("**Vendita:**"));
  assert.ok(body.includes("la pagina di dettaglio non è stata verificata"));
  assert.ok(body.includes(`- [Apri l'annuncio sul PVP](${URL_A})`));
});
