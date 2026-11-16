// Formato della notifica (issue GitHub, quindi email) dei nuovi annunci.
// Funzioni pure, coperte dai test in test/notify-format.test.mjs.
import { clean, isValidIsoDate, shortTitle } from "./parse.mjs";

const WEEKDAYS = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];
const DAY_MS = 86_400_000;
const SUMMARY_TITLE_LENGTH = 70;
// Sotto questa soglia la scadenza delle offerte viene evidenziata.
const URGENT_DAYS = 7;
const ZERO_WIDTH_SPACE = "​";

function parseIso(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?$/);
  if (!match || !isValidIsoDate(match[1])) return null;
  return { date: match[1], time: match[2] || null };
}

// "2026-11-13" → "13/11/2026"; un valore non riconosciuto resta invariato.
export function formatDate(value) {
  const parsed = parseIso(value);
  if (!parsed) return clean(value) || null;
  const [year, month, day] = parsed.date.split("-");
  return `${day}/${month}/${year}`;
}

// "2027-01-14T11:45" → "gio 14/01/2027 ore 11:45".
export function formatDateTime(value) {
  const parsed = parseIso(value);
  if (!parsed) return clean(value) || null;
  const weekday = WEEKDAYS[new Date(`${parsed.date}T00:00:00Z`).getUTCDay()];
  return `${weekday} ${formatDate(parsed.date)}${parsed.time ? ` ore ${parsed.time}` : ""}`;
}

// Giorni di calendario tra due date ISO (l'eventuale ora viene ignorata).
export function daysBetween(from, to) {
  const start = parseIso(from);
  const end = parseIso(to);
  if (!start || !end) return null;
  return Math.round((Date.parse(`${end.date}T00:00:00Z`) - Date.parse(`${start.date}T00:00:00Z`)) / DAY_MS);
}

function relativeDays(days) {
  if (days === null) return "";
  if (days < 0) return " (già scaduto)";
  if (days === 0) return " (oggi)";
  if (days === 1) return " (domani)";
  return ` (tra ${days} giorni)`;
}

// Data del controllo nel fuso italiano: è il "oggi" di chi riceve la notifica.
export function referenceDateOf(latest) {
  const checked = new Date(latest?.checked_at || "");
  if (Number.isNaN(checked.getTime())) return latest?.target_date || null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(checked);
}

// Il testo del PVP è libero: va reso innocuo per il Markdown di GitHub, che
// altrimenti interpreta "*", "_", "|", "<", un "#" o "1." iniziale, e trasforma
// "@nome" e "#123" in menzioni e collegamenti a issue.
export function escapeMarkdown(value) {
  return clean(value)
    .replace(/[\\`*_[\]<>|~]/g, "\\$&")
    .replace(/^(?:#+|[-+])(?=\s|$)/, "\\$&")
    .replace(/^(\d+)([.)])(?=\s|$)/, "$1\\$2")
    .replace(/(^|[^\p{L}\p{N}])([@#])(?=[\p{L}\p{N}])/gu, `$1$2${ZERO_WIDTH_SPACE}`);
}

function tokensOf(value) {
  return clean(value)
    .normalize("NFD")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) || [];
}

// Un testo è una ripetizione se quasi tutte le sue parole sono già nell'altro:
// quota minima in comune e numero massimo di parole mancanti (per non perdere
// una frase intera in fondo a un testo lungo).
const REPEAT_SHARE = 0.85;
const REPEAT_MAX_MISSING = 2;

// Vero se `text` non aggiunge nulla a `other`: tutte le sue cifre (importi,
// identificativi, codici) e quasi tutte le sue parole compaiono già lì. La
// tolleranza copre refusi e varianti minime ("identificativo 123" / "123").
export function isRepeatedIn(text, other) {
  const tokens = tokensOf(text);
  if (tokens.length === 0) return true;
  const known = new Set(tokensOf(other));
  const missing = tokens.filter((token) => !known.has(token));
  if (missing.some((token) => /\d/.test(token))) return false;
  return (
    missing.length <= REPEAT_MAX_MISSING &&
    (tokens.length - missing.length) / tokens.length >= REPEAT_SHARE
  );
}

// Il PVP ripete spesso la descrizione del lotto nei "beni inclusi", a volte più
// completa e a volte troncata: si tengono solo i testi che aggiungono qualcosa.
export function distinctTexts(announcement) {
  const description = clean(announcement.credit_description);
  const assets = [];
  for (const asset of (announcement.asset_descriptions || []).map(clean).filter(Boolean)) {
    if (description && isRepeatedIn(asset, description)) continue;
    if (assets.some((kept) => isRepeatedIn(asset, kept))) continue;
    // Un bene più completo sostituisce quelli che ripete.
    for (let index = assets.length - 1; index >= 0; index -= 1) {
      if (isRepeatedIn(assets[index], asset)) assets.splice(index, 1);
    }
    assets.push(asset);
  }
  const descriptionRepeated = assets.some((asset) => isRepeatedIn(description, asset));
  if (!description || descriptionRepeated) return { description: null, assets };

  return { description, assets: assets.map((asset) => withoutSharedStart(asset, description)) };
}

// Inizio in comune oltre il quale di un bene si mostra solo la parte nuova.
const SHARED_START_MIN_LENGTH = 60;

// Spesso un bene ricopia l'inizio della descrizione e cambia solo nel finale:
// si mostra "… finale" invece di ripetere tutto il testo.
export function withoutSharedStart(text, reference) {
  let shared = 0;
  while (shared < text.length && shared < reference.length && text[shared] === reference[shared]) {
    shared += 1;
  }
  // Si taglia a fine parola, senza spezzare l'ultima parola in comune.
  if (shared < text.length && shared < reference.length) {
    shared = text.lastIndexOf(" ", shared) + 1;
  }
  const rest = text.slice(shared).trim();
  if (shared < SHARED_START_MIN_LENGTH || !rest) return text;
  // Se anche il finale ricalca il riferimento (cambia solo un numero o una
  // parola nel mezzo), il frammento da solo non si capirebbe: resta il testo intero.
  const known = new Set(tokensOf(reference));
  const restTokens = tokensOf(rest);
  const repeated = restTokens.filter((token) => known.has(token)).length;
  if (repeated * 2 >= restTokens.length) return text;
  return `… ${rest}`;
}

function priceValue(text) {
  const match = String(text || "").match(/\d[\d.]*(?:,\d+)?/);
  if (!match) return null;
  const value = Number(match[0].replace(/\./g, "").replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

function deadlineOf(announcement) {
  return announcement.offer_deadline || announcement.sale_date || null;
}

// Prima le scadenze più vicine; i lotti della stessa procedura restano vicini,
// dal prezzo base più alto al più basso.
export function sortAnnouncements(announcements) {
  return announcements
    .map((announcement, index) => ({ announcement, index }))
    .sort((a, b) => {
      const byDeadline = (deadlineOf(a.announcement) || "9999").localeCompare(
        deadlineOf(b.announcement) || "9999",
      );
      if (byDeadline) return byDeadline;
      const byProcedure = clean(a.announcement.court_or_procedure).localeCompare(
        clean(b.announcement.court_or_procedure),
        "it",
      );
      if (byProcedure) return byProcedure;
      const byPrice =
        (priceValue(b.announcement.base_auction_price) ?? -1) -
        (priceValue(a.announcement.base_auction_price) ?? -1);
      return byPrice || a.index - b.index;
    })
    .map(({ announcement }) => announcement);
}

function countLabel(count) {
  return count === 1 ? "1 nuovo annuncio" : `${count} nuovi annunci`;
}

export function notificationTitle(latest, announcements) {
  const deadlines = announcements.map((item) => item.offer_deadline).filter(Boolean).sort();
  const first = deadlines.length ? ` – prima scadenza offerte ${formatDate(deadlines[0].slice(0, 10))}` : "";
  return `PVP: ${countLabel(announcements.length)} del ${formatDate(latest?.target_date)}${first}`;
}

function summaryRow(announcement, position) {
  const { description, assets } = distinctTexts(announcement);
  const subject = shortTitle(description || assets[0] || announcement.title, SUMMARY_TITLE_LENGTH);
  const deadline = deadlineOf(announcement);
  const cells = [
    String(position),
    escapeMarkdown(announcement.base_auction_price) || "–",
    deadline ? formatDate(deadline.slice(0, 10)) : "–",
    escapeMarkdown(announcement.court_or_procedure) || "–",
    `[${escapeMarkdown(subject) || "Annuncio PVP"}](${announcement.official_url})`,
  ];
  return `| ${cells.join(" | ")} |`;
}

function section(announcement, position, referenceDate) {
  const { description, assets } = distinctTexts(announcement);
  const heading = [announcement.base_auction_price, announcement.court_or_procedure]
    .map(escapeMarkdown)
    .filter(Boolean)
    .join(" · ");

  const days = daysBetween(referenceDate, announcement.offer_deadline);
  const urgent = days !== null && days >= 0 && days <= URGENT_DAYS ? "⏰ " : "";
  const facts = [
    announcement.offer_deadline &&
      `- ${urgent}**Termine offerte:** ${formatDateTime(announcement.offer_deadline)}${relativeDays(days)}`,
    (announcement.sale_date || announcement.sale_type) &&
      `- **Vendita:** ${[formatDateTime(announcement.sale_date), escapeMarkdown(announcement.sale_type)]
        .filter(Boolean)
        .join(" · ")}`,
    announcement.detail_verified
      ? null
      : "- ⚠️ Dati presi dalla sola lista dei risultati: la pagina di dettaglio non è stata verificata.",
    `- [Apri l'annuncio sul PVP](${announcement.official_url})`,
  ].filter(Boolean);

  const single = assets.length === 1;
  return [
    `### ${position}. ${heading || "Annuncio PVP"}`,
    description ? escapeMarkdown(description) : null,
    ...assets.map((asset, index) =>
      description || !single
        ? `**${single ? "Dettaglio del bene" : `Bene ${index + 1}`}:** ${escapeMarkdown(asset)}`
        : escapeMarkdown(asset),
    ),
    facts.join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function notificationBody(latest, announcements) {
  const referenceDate = referenceDateOf(latest);
  const sorted = sortAnnouncements(announcements);
  const count = sorted.length;

  const intro = `**${countLabel(count)}** ${count === 1 ? "pubblicato" : "pubblicati"} sul PVP il ${formatDate(
    latest?.target_date,
  )}${count > 1 ? ", in ordine di scadenza delle offerte" : ""}.`;
  const warning =
    latest?.status === "success"
      ? null
      : `> ⚠️ Controllo non completo (stato \`${latest?.status}\`): ${escapeMarkdown(
          latest?.error || "copertura incompleta",
        )}. Potrebbero mancare annunci.`;
  // Con un solo annuncio il riepilogo ripeterebbe la scheda.
  const summary =
    count > 1
      ? [
          "| # | Prezzo base | Termine offerte | Procedura | Oggetto |",
          "| ---: | ---: | --- | --- | --- |",
          ...sorted.map((announcement, index) => summaryRow(announcement, index + 1)),
        ].join("\n")
      : null;

  return `${[
    intro,
    warning,
    summary,
    summary ? "---" : null,
    ...sorted.map((announcement, index) => section(announcement, index + 1, referenceDate)),
  ]
    .filter(Boolean)
    .join("\n\n")}\n`;
}
