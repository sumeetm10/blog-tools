const fs = require("fs");
const path = require("path");

const API_BASE = "https://api.nepsetrading.com";
const OUTPUT_FILE = path.join(__dirname, "blogs-to-post.json");

// ─── Sector / symbol filter ───
// Skip stocks whose sector matches any of these keywords (case-insensitive).
// HIDCLP is whitelisted even though it would otherwise be filtered as a promoter share.
const SKIP_SECTOR_RE = /mutual\s*fund|debenture|bond|promoter/i;
const ALWAYS_KEEP = new Set(["HIDCLP"]);

function shouldKeep(item) {
  if (!item) return false;
  const sym = String(item.symbol || "").toUpperCase();
  if (ALWAYS_KEEP.has(sym)) return true;
  const sec = String(item.sector || "");
  return !SKIP_SECTOR_RE.test(sec);
}

// Apply filter to a stock list, log how many were skipped.
function filterStocks(arr, label) {
  if (!Array.isArray(arr)) return [];
  const before = arr.length;
  const out = arr.filter(shouldKeep);
  const skipped = before - out.length;
  if (skipped > 0) {
    const skippedSyms = arr
      .filter((x) => !shouldKeep(x))
      .map((x) => x.symbol)
      .join(", ");
    console.log(`   • ${label}: kept ${out.length}/${before}, skipped ${skipped} (${skippedSyms})`);
  }
  return out;
}

// ─── Helpers ───
function top(arr, n = 5) { return (arr || []).slice(0, n); }
function row(item) {
  return `<tr><td>${item.symbol}</td><td>${item.fullname || item.fullName || ""}</td><td>${item.sector || ""}</td><td>${item.latesttransactionprice || item.currentPrice || ""}</td><td>${Number(item.pointchange || 0) > 0 ? "+" : ""}${Number(item.pointchange || 0).toFixed(2)}</td><td>${Number(item.percentagechange || 0).toFixed(2)}%</td><td>${Number(item.volume || 0).toLocaleString()}</td></tr>`;
}
function rsiRow(item) {
  return `<tr><td>${item.symbol}</td><td>${Number(item.currentPrice).toFixed(2)}</td><td>${Number(item.rsi14).toFixed(2)}</td><td>${item.category}</td><td>${item.decision}</td><td>${Number(item.totalScore).toFixed(1)}</td><td>${item.explanation || ""}</td></tr>`;
}
function macdRow(item) {
  return `<tr><td>${item.symbol}</td><td>${Number(item.currentPrice).toFixed(2)}</td><td>${Number(item.macdLine).toFixed(2)}</td><td>${Number(item.histogram).toFixed(2)}</td><td>${item.macdStatus}</td><td>${item.decision}</td><td>${item.momentumState}</td></tr>`;
}
function table(headers, items) {
  return `<table><thead><tr>${headers.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${items.join("")}</tbody></table>`;
}
const th = ["Symbol", "Company", "Sector", "LTP", "Change", "% Change", "Volume"];
const rsiTh = ["Symbol", "Price", "RSI(14)", "Category", "Decision", "Score", "Signal"];
const macdTh = ["Symbol", "Price", "MACD Line", "Histogram", "Status", "Decision", "Momentum"];
// sectorTh removed — using statusTh from data prep section

async function main() {
  console.log("📊 Fetching NEPSE market data...\n");

  const [gainers, losers, turnover, status, rsiData, macdData, macdSummary, nepseIndex, bankIndex, hydroIndex, finIndex] = await Promise.all([
    fetch(`${API_BASE}/market-summary/top-gainers`).then(r => r.json()),
    fetch(`${API_BASE}/market-summary/top-losers`).then(r => r.json()),
    fetch(`${API_BASE}/market-summary/top-turnover`).then(r => r.json()),
    fetch(`${API_BASE}/market-summary/market-status`).then(r => r.json()),
    fetch(`${API_BASE}/rsi/rankings?limit=20&sortBy=total_score&sortOrder=DESC`).then(r => r.json()),
    fetch(`${API_BASE}/macd/rankings?limit=20&sortBy=total_score&sortOrder=DESC`).then(r => r.json()),
    fetch(`${API_BASE}/macd/summary`).then(r => r.json()),

    fetch(`${API_BASE}/live-stock-data?code=NEPSE`).then(r => r.json()),
    fetch(`${API_BASE}/live-stock-data?code=BANKING`).then(r => r.json()),
    fetch(`${API_BASE}/live-stock-data?code=HYDROPOWER`).then(r => r.json()),
    fetch(`${API_BASE}/live-stock-data?code=FINANCE`).then(r => r.json()),
  ]);

  console.log(`✅ Fetched: ${gainers.length} gainers, ${losers.length} losers, ${turnover.length} turnover`);

  // ─── Session guard (CI runs on a timer, so it must refuse non-sessions) ───
  // NEPSE date = Kathmandu date (UTC+05:45), not the UTC date.
  const nptToday = new Date(Date.now() + 345 * 60 * 1000).toISOString().split("T")[0];
  const idxDate = String((nepseIndex && nepseIndex[0] && nepseIndex[0].date) || "").slice(0, 10);
  if (idxDate !== nptToday) {
    console.log(`No NEPSE session today (${nptToday}); latest index bar is ${idxDate || "missing"}. Nothing written.`);
    process.exit(0);
  }
  if (status && status.isOpen === true && !process.argv.includes("--allow-open")) {
    console.log("Market is still open; closing figures are not final. Nothing written. Re-run after 15:00 NPT.");
    process.exit(0);
  }

  // ─── Apply sector/symbol filter (skip MUTUAL FUND, DEBENTURE, BOND, PROMOTER except HIDCLP) ───
  console.log("🚫 Applying sector filter:");
  const fGainers = filterStocks(gainers, "gainers");
  const fLosers = filterStocks(losers, "losers");
  const fTurnover = filterStocks(turnover, "turnover");
  const fRsi = filterStocks(rsiData.data || [], "rsi rankings");
  const fMacd = filterStocks(macdData.data || [], "macd rankings");

  // Replace originals in-place so all downstream code naturally uses filtered data
  // without needing rename across ~100+ references in this file.
  gainers.length = 0; gainers.push(...fGainers);
  losers.length = 0; losers.push(...fLosers);
  turnover.length = 0; turnover.push(...fTurnover);

  console.log(`✅ After filter: ${gainers.length} gainers, ${losers.length} losers, ${turnover.length} turnover\n`);

  // ─── Data prep ───
  const rsi = fRsi;
  const macd = fMacd;
  // MACD summary has: statusBreakdown, decisionBreakdown, signalStats, topStocks
  const macdSum = macdSummary.data || {};
  const macdStats = macdSum.signalStats || {};
  const macdDecisions = macdSum.decisionBreakdown || [];
  const macdStatuses = macdSum.statusBreakdown || [];
  const macdTopStocks = filterStocks(macdSum.topStocks || [], "macd summary topStocks");
  const macdBuyCount = macdDecisions.find(x => x.decision === "Buy")?.count || 0;
  const macdHoldCount = macdDecisions.find(x => x.decision === "Hold")?.count || 0;
  const macdAvoidCount = macdDecisions.find(x => x.decision === "Avoid")?.count || 0;
  const macdLeaderCount = macdStatuses.find(x => x.status === "Leader")?.count || 0;
  const macdTotalStocks = macdSum.totalStocks || 0;

  const rsiBuy = rsi.filter(x => x.decision === "Buy");
  const rsiHold = rsi.filter(x => x.decision === "Hold");
  const macdBullish = macd.filter(x => x.bullishCross);
  const macdBearish = macd.filter(x => x.bearishCross);
  const macdAboveZero = macd.filter(x => x.aboveZeroLine);

  const idx = nepseIndex[0] || {};
  const bank = bankIndex[0] || {};
  const hydro = hydroIndex[0] || {};
  const fin = finIndex[0] || {};


  const today = nptToday;
  const g = top(gainers, 10);
  const l = top(losers, 10);
  const t = top(turnover, 10);
  const g5 = top(gainers, 5);
  const l5 = top(losers, 5);
  const t5 = top(turnover, 5);
  const rsi5 = top(rsi, 5);
  const rsi10 = top(rsi, 10);
  const macd5 = top(macd, 5);
  const macd10 = top(macd, 10);

  const gainerSectors = {};
  gainers.forEach(x => { gainerSectors[x.sector] = (gainerSectors[x.sector] || 0) + 1; });
  const loserSectors = {};
  losers.forEach(x => { loserSectors[x.sector] = (loserSectors[x.sector] || 0) + 1; });
  const topGS = Object.entries(gainerSectors).sort((a, b) => b[1] - a[1])[0] || ["N/A", 0];
  const topLS = Object.entries(loserSectors).sort((a, b) => b[1] - a[1])[0] || ["N/A", 0];
  const totalTurnover = turnover.reduce((sum, x) => sum + Number(x.turnover || 0), 0);
  const breadth = gainers.length > losers.length ? "positive" : gainers.length < losers.length ? "negative" : "neutral";
  const adRatio = (gainers.length / (losers.length || 1)).toFixed(2);

  // MACD status table rows (Leader/Strong/Neutral/Weak)
  const sectorRows = macdStatuses.map(s =>
    `<tr><td>${s.status}</td><td>${s.count}</td><td>${s.avgScore.toFixed(1)}</td><td>${s.minScore}</td><td>${s.maxScore}</td></tr>`
  );
  const statusTh = ["Status", "Count", "Avg Score", "Min", "Max"];

  // MACD top stocks from summary
  const macdTop3 = macdTopStocks.slice(0, 3);

  // Index summary line (reused across blogs)
  const idxDir = Number(idx.point_change) >= 0 ? "up" : "down";
  const idxSign = Number(idx.point_change) >= 0 ? "+" : "";
  const idxLine = `NEPSE closed at <strong>${Number(idx.close).toFixed(2)}</strong>, ${idxDir} <strong>${idxSign}${Number(idx.point_change).toFixed(2)} points (${idxSign}${Number(idx.percentage_change).toFixed(2)}%)</strong> from the previous close of ${Number(idx.previous_close).toFixed(2)}. The index traded between ${Number(idx.low).toFixed(2)} (low) and ${Number(idx.high).toFixed(2)} (high), opening at ${Number(idx.open).toFixed(2)}.`;
  const sectorIdxLine = `<strong>Sector Indices:</strong> Banking ${Number(bank.close).toFixed(2)} (${Number(bank.point_change)>=0?"+":""}${Number(bank.percentage_change).toFixed(2)}%), Hydropower ${Number(hydro.close).toFixed(2)} (${Number(hydro.point_change)>=0?"+":""}${Number(hydro.percentage_change).toFixed(2)}%), Finance ${Number(fin.close).toFixed(2)} (${Number(fin.point_change)>=0?"+":""}${Number(fin.percentage_change).toFixed(2)}%).`;

  // Sector-level data from gainer/loser counts (price-based, not MACD)
  const bankGainers = gainerSectors["COMMERCIAL BANKS"] || 0;
  const bankLosers = loserSectors["COMMERCIAL BANKS"] || 0;
  const hydroGainers = gainerSectors["HYDROPOWER"] || 0;
  const hydroLosers = loserSectors["HYDROPOWER"] || 0;
  const finGainers = gainerSectors["FINANCE"] || 0;
  const finLosers = loserSectors["FINANCE"] || 0;

  // ─── Direction-aware language helpers ───
  const isUp = Number(idx.point_change) > 0;
  const isDown = Number(idx.point_change) < 0;
  const isFlat = Number(idx.point_change) === 0;
  const idxVerb = isUp ? "gained" : isDown ? "lost" : "ended flat at";
  const idxAction = isUp ? "rallied" : isDown ? "fell" : "stayed flat";
  const idxAbsPts = Math.abs(Number(idx.point_change)).toFixed(2);
  const idxAbsPct = Math.abs(Number(idx.percentage_change)).toFixed(2);
  const idxPctSigned = `${isUp ? "+" : isDown ? "-" : ""}${idxAbsPct}`;
  const idxPtsSigned = `${isUp ? "+" : isDown ? "-" : ""}${idxAbsPts}`;

  // Sector pct helper (signed)
  const sPct = (sec) => `${Number(sec.percentage_change) >= 0 ? "+" : ""}${Number(sec.percentage_change).toFixed(2)}%`;

  // True market-wide MACD positivity (from summary, not top-5 sample)
  const macdPosTotal = macdStats.aboveZeroLine || 0;
  const macdPosPct = macdTotalStocks > 0 ? ((macdPosTotal / macdTotalStocks) * 100).toFixed(0) : "0";

  // Sector rotation (handle same-sector case)
  const rotationLine = topGS[0] === topLS[0]
    ? `${topGS[0]} saw mixed action with ${topGS[1]} gainers and ${topLS[1]} losers`
    : `Money rotated from ${topLS[0]} into ${topGS[0]}`;

  // ─── Unique intro summaries for card excerpts ───
  const intro = [
    /*1*/  `NEPSE ${idxAction} ${idxAbsPts} points to ${Number(idx.close).toFixed(2)} on ${today} with ${gainers.length} gainers vs ${losers.length} losers. ${g[0]?.symbol} led at +${Number(g[0]?.percentagechange).toFixed(2)}%. Full closing report with top gainers, losers, turnover data and sector breakdown.`,
    /*2*/  `Nepal's stock market ${idxVerb} ${idxAbsPct}% today. ${topGS[0]} dominated with ${topGS[1]} gaining stocks. Banking index at ${Number(bank.close).toFixed(2)} (${sPct(bank)}), Hydropower at ${Number(hydro.close).toFixed(2)} (${sPct(hydro)}). Sector performance and outlook analysis.`,
    /*3*/  `Smart money flowed into ${t[0]?.symbol} (${Number(t[0]?.volume).toLocaleString()} shares) and ${t[1]?.symbol} today as NEPSE ${idxDir} ${idxAbsPts} pts. ${macdPosTotal}/${macdTotalStocks} stocks above MACD zero line. Volume and smart money flow analysis.`,
    /*4*/  `NEPSE ${idxAction} ${idxAbsPts} points today. ${topGS[0]} sector buying (${topGS[1]} stocks) and ${g[0]?.symbol} (+${Number(g[0]?.percentagechange).toFixed(2)}%) ${isUp ? "drove the gains" : "couldn't prevent the decline"}. Here's the full breakdown of why the market ${isUp ? "went up" : isDown ? "went down" : "stayed flat"}.`,
    /*5*/  `Technical signals for ${today}: ${rsiBuy.length} RSI Buy signals, ${macdLeaderCount} MACD Leaders, ${macdBullish.length} bullish crosses. Top RSI pick: ${rsi[0]?.symbol} (${rsi[0]?.totalScore.toFixed(1)}). NEPSE at ${Number(idx.close).toFixed(2)}. RSI, MACD and trend prediction inside.`,
    /*6*/  `NEPSE index ${idxDir} ${idxAbsPct}% to ${Number(idx.close).toFixed(2)}. Banking ${sPct(bank)}, Hydropower ${sPct(hydro)}, Finance ${sPct(fin)}. Complete sector-wise turnover and performance analysis.`,
    /*7*/  `Is NEPSE breaking out or correcting? Index at ${Number(idx.close).toFixed(2)} (${idxPtsSigned} pts). ${macdPosTotal}/${macdTotalStocks} MACD above zero, breadth ${adRatio} A/D ratio. Breakout and correction signals analyzed.`,
    /*8*/  `Today's top stocks: ${g[0]?.symbol} +${Number(g[0]?.percentagechange).toFixed(2)}%, volume leader ${t[0]?.symbol} (${Number(t[0]?.volume).toLocaleString()} shares). Market sentiment: ${breadth}. NEPSE at ${Number(idx.close).toFixed(2)} with ${gainers.length} gainers. Full update with sentiment assessment.`,
    /*9*/  `OHLC price action analysis for ${today}: NEPSE opened ${Number(idx.open).toFixed(2)}, high ${Number(idx.high).toFixed(2)}, low ${Number(idx.low).toFixed(2)}, closed ${Number(idx.close).toFixed(2)}. ${g.filter(x=>Number(x.high)===Number(x.latesttransactionprice)).length} stocks closed at day high. Key support and resistance levels explained.`,
    /*10*/ `Banking index ${sPct(bank)}, Hydropower ${sPct(hydro)}, Finance ${sPct(fin)}. Top MACD picks: ${macdTop3.map(s=>s.symbol).join(", ")}. ${macdBuyCount} Buy, ${macdHoldCount} Hold signals across ${macdTotalStocks} stocks.`,
    /*11*/ `NEPSE trend: ${breadth} with ${gainers.length} gainers. Investor sentiment score based on breadth (${adRatio}), RSI (${rsiBuy.length} Buy), MACD (${macdPosTotal} above zero). Next day prediction and stocks to watch for ${today}.`,
    /*12*/ `${rsiBuy.length} RSI Buy signals, ${macdBullish.length} MACD bullish crosses, ${rsi.filter(x=>x.bullishDivergence).length} bullish divergences today. NEPSE closed ${Number(idx.close).toFixed(2)} (${idxPtsSigned} pts). Complete technical signal summary with data tables.`,
    /*13*/ `NEPSE at ${Number(idx.close).toFixed(2)} — liquidity concentrated in ${t[0]?.symbol} and ${t[1]?.symbol}. ${t.filter(x=>Number(x.percentagechange)>0).length}/10 turnover leaders ended positive. Smart money ${t.filter(x=>Number(x.percentagechange)>0).length>5 ? "favored buying" : "showed distribution"}. Index, liquidity and flow analysis.`,
    /*14*/ `Key levels for ${today}: NEPSE support ${Number(idx.low).toFixed(2)}, resistance ${Number(idx.high).toFixed(2)}. ${g[0]?.symbol} support Rs.${g[0]?.low}. ${macdPosTotal}/${macdTotalStocks} MACD in uptrend. RSI and MACD trend direction analysis with support/resistance levels.`,
    /*15*/ `Who led NEPSE today? Price: ${g[0]?.symbol} (+${Number(g[0]?.percentagechange).toFixed(2)}%). Volume: ${t[0]?.symbol} (${Number(t[0]?.volume).toLocaleString()}). RSI: ${rsi[0]?.symbol} (${rsi[0]?.totalScore.toFixed(1)}). MACD: ${macd[0]?.symbol} (${macd[0]?.totalScore}). Complete market leadership analysis.`,
    /*16*/ `Was today profit booking or fresh buying? ${gainers.length} gainers vs ${losers.length} losers. ${macdBullish.length} bullish vs ${macdBearish.length} bearish MACD crosses. NEPSE ${idxDir} ${idxAbsPts} pts. Evidence-based breakdown of buying and selling activity.`,
    /*17*/ `${rotationLine} today. NEPSE ${idxPtsSigned} pts to ${Number(idx.close).toFixed(2)}. Banking ${sPct(bank)}, Hydropower ${sPct(hydro)}. Sector rotation map and key movers.`,
    /*18*/ `NEPSE at ${Number(idx.close).toFixed(2)} (${idxPtsSigned}). What should investors do next? ${breadth} breadth, ${rsiBuy.length} RSI Buy signals, deposits at 4.54%. Actionable insights for aggressive, moderate and conservative investors.`,
    /*19*/ `Market strength: ${topGS[0]} (${topGS[1]} gainers), NEPSE ${idxPctSigned}%. Weakness: ${topLS[0]} (${topLS[1]} losers). Trading strategies for next session — aggressive, moderate and conservative approaches with risk management.`,
    /*20*/ `Complete NEPSE analysis for ${today}: Index ${Number(idx.close).toFixed(2)} (${idxPtsSigned} pts, ${idxPctSigned}%). ${gainers.length} up, ${losers.length} down. RSI ${rsiBuy.length} Buy. MACD ${macdPosPct}% positive (market-wide). Tomorrow: ${isUp && gainers.length > losers.length ? "bullish bias" : isDown ? "cautious" : "neutral"}.`,
  ];

  // ─── 20 Blogs ───
  const blogs = [

    // 1. NEPSE Today Closing Report
    {
      title: `NEPSE Today Closing Report (${today}): Index Movement Turnover and Top Gainers Losers Nepal`,
      content: `<p>${intro[0]}</p><h2>NEPSE Closing Report — ${today}</h2><p>${idxLine}</p><p>Today's NEPSE trading session ended with ${gainers.length} advancing stocks and ${losers.length} declining stocks. ${sectorIdxLine}</p><h2>Top 5 Gainers</h2>${table(th, g5.map(row))}<h2>Top 5 Losers</h2>${table(th, l5.map(row))}<h2>Top 5 by Turnover</h2>${table(th, t5.map(row))}<h2>Market Breadth</h2><ul><li>Advancing: ${gainers.length} stocks</li><li>Declining: ${losers.length} stocks</li><li>A/D Ratio: ${adRatio} (${breadth})</li><li>Top Gainer: ${g[0]?.symbol} (+${Number(g[0]?.percentagechange).toFixed(2)}%)</li><li>Top Loser: ${l[0]?.symbol} (${Number(l[0]?.percentagechange).toFixed(2)}%)</li><li>Volume Leader: ${t[0]?.symbol} (${Number(t[0]?.volume).toLocaleString()} shares)</li></ul><h2>Sector Performance</h2><p>Strongest sector: ${topGS[0]} with ${topGS[1]} gaining stocks. Weakest: ${topLS[0]} with ${topLS[1]} declining stocks.</p><h2>Conclusion</h2><p>Today's session showed ${breadth} breadth. ${topGS[0]} led the gains while ${topLS[0]} faced selling pressure. Volume was concentrated in ${t[0]?.symbol} and ${t[1]?.symbol}.</p>`,
      quick_answer: intro[0], category_id: 3, tags: ["56", "55", "22"],
      meta_title: `NEPSE Closing Report ${today}: Gainers Losers Turnover Nepal`,
      meta_description: `NEPSE ${today}: Index ${Number(idx.close).toFixed(2)} (${idxSign}${Number(idx.point_change).toFixed(2)} pts). ${g[0]?.symbol} +${Number(g[0]?.percentagechange).toFixed(2)}% top gainer. ${gainers.length} advancing vs ${losers.length} declining.`,
      secondary_keywords: [`NEPSE closing report ${today}`, "NEPSE today gainers losers", "Nepal stock market closing", "NEPSE turnover today", "NEPSE daily report"],
      bullet_key_points: [`Top gainer: ${g[0]?.symbol} +${Number(g[0]?.percentagechange).toFixed(2)}%`, `Top loser: ${l[0]?.symbol} ${Number(l[0]?.percentagechange).toFixed(2)}%`, `Volume leader: ${t[0]?.symbol}`, `Breadth: ${gainers.length} up vs ${losers.length} down`, `Strong sector: ${topGS[0]}`, `Weak sector: ${topLS[0]}`],
      faqs: [{ question: `What was NEPSE's top gainer today (${today})?`, answer: `${g[0]?.fullname} (${g[0]?.symbol}) gained +${Number(g[0]?.percentagechange).toFixed(2)}% to Rs. ${g[0]?.latesttransactionprice}.` }, { question: `How was market breadth today?`, answer: `${breadth} — ${gainers.length} stocks advanced and ${losers.length} declined (A/D ratio: ${adRatio}).` }],
      entity_tags: ["NEPSE", "closing report", g[0]?.symbol, l[0]?.symbol, t[0]?.symbol, topGS[0]]
    },

    // 2. Nepal Stock Market Today: Sector Performance & Outlook
    {
      title: `Nepal Stock Market Today (${today}): NEPSE Index Analysis Sector Performance and Outlook`,
      content: `<p>${intro[1]}</p><h2>Nepal Stock Market — ${today}</h2><p>${idxLine}</p><p>A comprehensive look at today's NEPSE performance across sectors, with technical signals from RSI and MACD analysis.</p><p>${sectorIdxLine}</p><h2>Sector-wise MACD Summary</h2>${table(statusTh, sectorRows)}<h2>Strongest Sectors by MACD Score</h2><ul>${macdStatuses.map(s=>`<li><strong>${s.status}:</strong> ${s.count} stocks, Avg Score ${s.avgScore.toFixed(1)} (${s.minScore}-${s.maxScore} range)</li>`).join("")}</ul><h2>Top Gainers and Losers</h2><ul><li>Gainers led by ${topGS[0]} sector (${topGS[1]} stocks)</li><li>Losers concentrated in ${topLS[0]} (${topLS[1]} stocks)</li></ul><h2>Outlook</h2><p>MACD sector data shows ${macdStatuses.filter(s=>s.avgScore>50).length} sectors with above-average momentum scores. Banking sector (avg ${(macdTop3[0]?.totalScore || 0)}) and Hydropower (avg ${(macdTop3[1]?.totalScore || 0)}) are key sectors to watch. ${breadth === "positive" ? "Positive breadth suggests continuation." : "Negative breadth suggests caution for next session."}</p>`,
      quick_answer: intro[1], category_id: 3, tags: ["56", "55", "22"],
      meta_title: `Nepal Stock Market ${today}: Sector Performance & MACD Outlook`,
      meta_description: `NEPSE ${today}: Banking avg MACD ${(macdTop3[0]?.totalScore || 0)}, Hydropower ${(macdTop3[1]?.totalScore || 0)}. ${macdStatuses.filter(s=>s.avgScore>50).length} sectors above average. Full sector analysis.`,
      secondary_keywords: [`Nepal stock market ${today}`, "NEPSE sector performance", "NEPSE index analysis today", "Nepal share market sectors", "NEPSE outlook"],
      bullet_key_points: [`Banking MACD avg: ${(macdTop3[0]?.totalScore || 0)}`, `Hydropower MACD avg: ${(macdTop3[1]?.totalScore || 0)}`, `${macdStatuses.filter(s=>s.avgScore>50).length} sectors above 50 score`, `Gainer sector: ${topGS[0]}`, `Loser sector: ${topLS[0]}`, `Breadth: ${breadth}`],
      faqs: [{ question: "Which sector performed best today?", answer: `${topGS[0]} led gainers with ${topGS[1]} stocks. By MACD score, Banking (${(macdTop3[0]?.totalScore || 0)}) shows the strongest technical momentum.` }],
      entity_tags: ["NEPSE", "sector analysis", "BANKING", "HYDROPOWER", "MACD", topGS[0]]
    },

    // 3. NEPSE Daily Market Wrap: Volume & Smart Money
    {
      title: `NEPSE Daily Market Wrap (${today}): Closing Analysis Volume and Smart Money Activity`,
      content: `<p>${intro[2]}</p><h2>NEPSE Market Wrap — ${today}</h2><p>${idxLine}</p><p>Where did smart money flow today? Volume analysis reveals institutional interest patterns.</p><h2>Top 10 by Turnover (Smart Money Signals)</h2>${table(th, t.map(row))}<h2>Volume + Price Analysis</h2><ul>${t5.map(x => `<li><strong>${x.symbol}</strong>: ${Number(x.volume).toLocaleString()} shares — ${Number(x.percentagechange) > 0 ? `UP +${Number(x.percentagechange).toFixed(2)}% (accumulation)` : Number(x.percentagechange) < 0 ? `DOWN ${Number(x.percentagechange).toFixed(2)}% (distribution)` : "FLAT"}</li>`).join("")}</ul><h2>Market Breadth</h2><ul><li>${gainers.length} advancing vs ${losers.length} declining — ${breadth} breadth</li><li>A/D Ratio: ${adRatio}</li></ul><h2>MACD Momentum Check</h2><ul><li>Stocks above MACD zero line: ${macdAboveZero.length} of ${macd.length} analyzed</li><li>Bullish crosses today: ${macdBullish.length}</li><li>Bearish crosses today: ${macdBearish.length}</li></ul><h2>Conclusion</h2><p>Smart money activity was concentrated in ${t[0]?.symbol} (${t[0]?.sector}) and ${t[1]?.symbol} (${t[1]?.sector}). ${macdAboveZero.length > macd.length / 2 ? "Majority of analyzed stocks have MACD above zero — overall bullish momentum." : "Less than half of stocks have MACD above zero — momentum is weakening."}</p>`,
      quick_answer: intro[2], category_id: 3, tags: ["56", "55", "22"],
      meta_title: `NEPSE Market Wrap ${today}: Volume Smart Money & MACD Signals`,
      meta_description: `NEPSE ${today}: Volume leader ${t[0]?.symbol}. ${macdAboveZero.length} stocks above MACD zero. ${macdBullish.length} bullish crosses. Smart money flow analysis.`,
      secondary_keywords: [`NEPSE wrap ${today}`, "NEPSE smart money", "NEPSE volume analysis", "Nepal stock market wrap", "NEPSE closing analysis"],
      bullet_key_points: [`Volume leader: ${t[0]?.symbol} (${Number(t[0]?.volume).toLocaleString()})`, `MACD above zero: ${macdAboveZero.length}/${macd.length}`, `Bullish crosses: ${macdBullish.length}`, `Bearish crosses: ${macdBearish.length}`, `Breadth: ${gainers.length} vs ${losers.length}`, `A/D Ratio: ${adRatio}`],
      faqs: [{ question: "Where did smart money flow today?", answer: `Highest volume in ${t[0]?.symbol} (${Number(t[0]?.volume).toLocaleString()} shares) and ${t[1]?.symbol}. ${Number(t[0]?.percentagechange) > 0 ? "Price up + high volume = accumulation signal." : "Price down + high volume = distribution signal."}` }],
      entity_tags: ["NEPSE", "smart money", "volume", "MACD", t[0]?.symbol, t[1]?.symbol]
    },

    // 4. NEPSE Today: Why Market Went Up or Down?
    {
      title: `NEPSE Today (${today}): Why Market Went Up or Down Full Analysis Nepal`,
      content: `<p>${intro[3]}</p><h2>Why Did NEPSE ${breadth === "positive" ? "Go Up" : breadth === "negative" ? "Go Down" : "Stay Mixed"} Today?</h2><p>${idxLine}</p><p>Today's NEPSE session saw ${gainers.length} stocks advance and ${losers.length} decline — a ${breadth} day. Here's what drove the market.</p><h2>Key Drivers</h2><ul><li><strong>Sector rotation:</strong> ${topGS[0]} attracted buyers (${topGS[1]} stocks up) while ${topLS[0]} faced selling (${topLS[1]} stocks down)</li><li><strong>Top mover impact:</strong> ${g[0]?.symbol} surged +${Number(g[0]?.percentagechange).toFixed(2)}% — ${g[0]?.sector} sector leading</li><li><strong>Volume signal:</strong> ${t[0]?.symbol} traded ${Number(t[0]?.volume).toLocaleString()} shares — ${Number(t[0]?.percentagechange) > 0 ? "buying interest" : "selling pressure"}</li><li><strong>Technical backdrop:</strong> ${macdAboveZero.length}/${macd.length} stocks have MACD above zero — ${macdAboveZero.length > macd.length / 2 ? "broadly bullish" : "momentum fading"}</li></ul><h2>RSI Signals</h2><p>Top RSI-rated stocks: ${rsi5.map(x => `${x.symbol} (RSI: ${x.rsi14.toFixed(1)}, ${x.decision})`).join(", ")}. ${rsiBuy.length > 0 ? `${rsiBuy.length} stocks have RSI Buy signal.` : "No stocks currently showing RSI Buy signal — market is in Hold/Avoid territory."}</p><h2>Gainers vs Losers</h2>${table(th, g5.map(row))}<p><strong>vs</strong></p>${table(th, l5.map(row))}<h2>Conclusion</h2><p>${breadth === "positive" ? `The market rose today driven by ${topGS[0]} sector strength and buying in ${g[0]?.symbol}. Positive breadth (${adRatio} A/D) suggests continuation.` : breadth === "negative" ? `Selling dominated today with ${topLS[0]} leading declines. Negative breadth (${adRatio} A/D) suggests caution.` : `Mixed session with no clear direction. Sector rotation between ${topGS[0]} (up) and ${topLS[0]} (down) defined the day.`}</p>`,
      quick_answer: intro[3], category_id: 3, tags: ["56", "55", "22"],
      meta_title: `NEPSE Today ${today}: Why Market ${breadth === "positive" ? "Rose" : "Fell"} — Full Analysis`,
      meta_description: `NEPSE ${today}: ${breadth} day. ${topGS[0]} led gains, ${topLS[0]} fell. ${g[0]?.symbol} +${Number(g[0]?.percentagechange).toFixed(2)}%. RSI and MACD signals explained.`,
      secondary_keywords: [`NEPSE why ${breadth} ${today}`, "NEPSE market analysis today", "Nepal stock market reason", "NEPSE up down analysis", "NEPSE today explanation"],
      bullet_key_points: [`Market: ${breadth} (${gainers.length} up, ${losers.length} down)`, `Driver: ${topGS[0]} sector buying`, `Top gainer: ${g[0]?.symbol} +${Number(g[0]?.percentagechange).toFixed(2)}%`, `MACD above zero: ${macdAboveZero.length}/${macd.length}`, `RSI Buy signals: ${rsiBuy.length}`, `Volume leader: ${t[0]?.symbol}`],
      faqs: [{ question: `Why did NEPSE ${breadth === "positive" ? "go up" : "go down"} today?`, answer: `${topGS[0]} sector strength (${topGS[1]} gainers) and ${g[0]?.symbol} (+${Number(g[0]?.percentagechange).toFixed(2)}%) drove the ${breadth} session. ${topLS[0]} faced selling.` }],
      entity_tags: ["NEPSE", "market analysis", g[0]?.symbol, l[0]?.symbol, topGS[0], topLS[0]]
    },

    // 5. Technical Analysis with RSI, MACD
    {
      title: `NEPSE Closing Today (${today}): Technical Analysis with RSI MACD and Trend Prediction`,
      content: `<p>${intro[4]}</p><h2>NEPSE Technical Analysis — ${today}</h2><p>${idxLine}</p><p>A data-driven technical analysis using RSI and MACD indicators for today's NEPSE session.</p><h2>RSI Analysis — Top 10 Stocks by Score</h2>${table(rsiTh, rsi10.map(rsiRow))}<h2>RSI Signal Distribution</h2><ul><li>Buy signals: ${rsiBuy.length} stocks</li><li>Hold signals: ${rsiHold.length} stocks</li><li>RSI Leaders (score 80+): ${rsi.filter(x => x.category === "Leader").length}</li><li>RSI Strong (65-80): ${rsi.filter(x => x.category === "Strong").length}</li><li>Bullish divergence: ${rsi.filter(x => x.bullishDivergence).length} stocks</li><li>Bearish divergence: ${rsi.filter(x => x.bearishDivergence).length} stocks</li></ul><h2>MACD Analysis — Top 10 Stocks</h2>${table(macdTh, macd10.map(macdRow))}<h2>MACD Signal Summary</h2><ul><li>Bullish crosses: ${macdBullish.length}</li><li>Bearish crosses: ${macdBearish.length}</li><li>Above zero line: ${macdAboveZero.length}/${macd.length}</li><li>Expanding momentum: ${macd.filter(x => x.histogramExpanding).length}</li><li>Volume confirmed: ${macd.filter(x => x.volumeConfirmed).length}</li></ul><h2>Trend Prediction</h2><p>${macdAboveZero.length > macd.length * 0.6 ? "Majority of stocks have MACD above zero — broad bullish trend intact." : macdAboveZero.length < macd.length * 0.4 ? "Less than 40% above MACD zero — bearish momentum dominating." : "Mixed MACD signals — market at inflection point."} ${rsiBuy.length > 3 ? `${rsiBuy.length} RSI Buy signals suggest potential upside.` : "Limited RSI Buy signals indicate caution."} ${rsi.filter(x => x.bearishDivergence).length > 3 ? `Warning: ${rsi.filter(x => x.bearishDivergence).length} stocks show bearish RSI divergence.` : ""}</p><h2>Top Technical Picks</h2><ul>${rsi5.map(x => `<li>${x.symbol}: RSI ${x.rsi14.toFixed(1)} (${x.category}/${x.decision}) — Score ${x.totalScore.toFixed(1)}</li>`).join("")}</ul>`,
      quick_answer: intro[4], category_id: 3, tags: ["56", "55", "22"],
      meta_title: `NEPSE Technical Analysis ${today}: RSI MACD Trend Prediction`,
      meta_description: `NEPSE ${today} technicals: ${rsiBuy.length} RSI Buy signals, ${macdBullish.length} MACD bullish crosses, ${macdAboveZero.length}/${macd.length} above zero. Top picks and trend prediction.`,
      secondary_keywords: [`NEPSE technical analysis ${today}`, "NEPSE RSI MACD today", "Nepal stock technical signals", "NEPSE trend prediction", "NEPSE RSI analysis"],
      bullet_key_points: [`RSI Buy: ${rsiBuy.length} stocks`, `RSI Bearish divergence: ${rsi.filter(x => x.bearishDivergence).length}`, `MACD Bullish crosses: ${macdBullish.length}`, `MACD above zero: ${macdAboveZero.length}/${macd.length}`, `Top RSI: ${rsi[0]?.symbol} (${rsi[0]?.totalScore.toFixed(1)})`, `Top MACD: ${macd[0]?.symbol} (${macd[0]?.totalScore})`],
      faqs: [{ question: "What do RSI signals say about NEPSE today?", answer: `${rsiBuy.length} Buy, ${rsiHold.length} Hold signals. Top RSI stock: ${rsi[0]?.symbol} at ${rsi[0]?.rsi14.toFixed(1)} (${rsi[0]?.decision}).` }, { question: "Is NEPSE trend bullish or bearish?", answer: `${macdAboveZero.length > macd.length / 2 ? "Broadly bullish" : "Weakening"} — ${macdAboveZero.length}/${macd.length} stocks have MACD above zero. ${macdBullish.length} bullish crosses vs ${macdBearish.length} bearish.` }],
      entity_tags: ["NEPSE", "RSI", "MACD", "technical analysis", rsi[0]?.symbol, macd[0]?.symbol]
    },

    // 6. Nepal Share Market: Sector-wise Analysis
    {
      title: `Nepal Share Market Today (${today}): Index Change Turnover and Sector-wise Analysis`,
      content: `<p>${intro[5]}</p><h2>Nepal Share Market — ${today}</h2><p>${idxLine}</p><p>A sector-by-sector breakdown of today's NEPSE performance. ${sectorIdxLine}</p><h2>Sector MACD Momentum Rankings</h2>${table(statusTh, sectorRows)}<h2>Sector Gainers vs Losers</h2><h3>Sectors with Most Gainers</h3><ul>${Object.entries(gainerSectors).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, c]) => `<li>${s}: ${c} gaining stocks</li>`).join("")}</ul><h3>Sectors with Most Losers</h3><ul>${Object.entries(loserSectors).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, c]) => `<li>${s}: ${c} declining stocks</li>`).join("")}</ul><h2>Key Sector Highlights</h2><ul><li><strong>Banking:</strong> MACD avg ${(macdTop3[0]?.totalScore || 0)}, ${macdHoldCount} Hold, ${macdAvoidCount} Avoid. Top: ${(macdTop3[0]?.symbol || "N/A")}</li><li><strong>Hydropower:</strong> MACD avg ${(macdTop3[1]?.totalScore || 0)}, ${macdHoldCount} Hold, ${macdAvoidCount} Avoid. Top: ${(macdTop3[1]?.symbol || "N/A")}</li><li><strong>Finance:</strong> MACD avg ${(macdTop3[2]?.totalScore || 0)}, ${macdHoldCount} Hold, ${macdAvoidCount} Avoid. Top: ${(macdTop3[2]?.symbol || "N/A")}</li></ul><h2>Turnover Leaders</h2>${table(th, t5.map(row))}<h2>Conclusion</h2><p>Sector rotation defines today's market. ${topGS[0]} attracted fresh buying while ${topLS[0]} saw profit booking. ${macdLeaderCount} stocks have Leader-level MACD momentum.</p>`,
      quick_answer: intro[5], category_id: 3, tags: ["56", "55", "22"],
      meta_title: `Nepal Share Market ${today}: Sector-wise Analysis & Turnover`,
      meta_description: `NEPSE sectors ${today}: Banking MACD ${(macdTop3[0]?.totalScore || 0)}, Hydropower ${(macdTop3[1]?.totalScore || 0)}. ${topGS[0]} led gainers. Full sector breakdown.`,
      secondary_keywords: [`Nepal share market ${today}`, "NEPSE sector analysis today", "Nepal stock sectors", "NEPSE sector turnover", "Nepal share bazar today"],
      bullet_key_points: [`Banking: avg ${(macdTop3[0]?.totalScore || 0)}, top ${(macdTop3[0]?.symbol || "N/A")}`, `Hydropower: avg ${(macdTop3[1]?.totalScore || 0)}, top ${(macdTop3[1]?.symbol || "N/A")}`, `Gainer sector: ${topGS[0]} (${topGS[1]})`, `Loser sector: ${topLS[0]} (${topLS[1]})`, `Volume leader: ${t[0]?.symbol}`, `${macdStatuses.filter(s => s.avgScore > 50).length} statuses above avg`],
      faqs: [{ question: "Which sector did best today?", answer: `${topGS[0]} had most gainers (${topGS[1]}). By MACD, Banking (${(macdTop3[0]?.totalScore || 0)}) shows strongest momentum.` }],
      entity_tags: ["NEPSE", "sectors", "BANKING", "HYDROPOWER", "FINANCE", topGS[0]]
    },

    // 7. Breakout or Correction?
    {
      title: `NEPSE Market Today (${today}): Breakout or Correction Daily Closing Analysis`,
      content: `<p>${intro[6]}</p><h2>Breakout or Correction? — ${today}</h2><p>${idxLine}</p><p>Is today's NEPSE action a sign of breakout momentum or a correction? Let's analyze the evidence.</p><h2>Breakout Signals</h2><ul><li>${gainers.length > losers.length ? `✅ More gainers (${gainers.length}) than losers (${losers.length}) — bullish breadth` : `❌ More losers (${losers.length}) than gainers (${gainers.length}) — bearish breadth`}</li><li>${macdAboveZero.length > macd.length * 0.5 ? `✅ ${macdAboveZero.length}/${macd.length} MACD above zero — bullish momentum` : `❌ Only ${macdAboveZero.length}/${macd.length} MACD above zero — weak momentum`}</li><li>${macdBullish.length > macdBearish.length ? `✅ More bullish (${macdBullish.length}) than bearish (${macdBearish.length}) MACD crosses` : `❌ More bearish (${macdBearish.length}) than bullish (${macdBullish.length}) crosses`}</li><li>${g[0] && Number(g[0].volume) > 10000 ? `✅ Top gainer ${g[0].symbol} has strong volume (${Number(g[0].volume).toLocaleString()})` : `⚠️ Top gainer volume is thin — move may not sustain`}</li></ul><h2>Correction Signals</h2><ul><li>${rsi.filter(x => x.bearishDivergence).length > 3 ? `⚠️ ${rsi.filter(x => x.bearishDivergence).length} stocks show RSI bearish divergence` : `✅ Limited bearish divergence`}</li><li>${macd.filter(x => x.histogramExpanding).length < macd.length * 0.3 ? `⚠️ Only ${macd.filter(x => x.histogramExpanding).length}/${macd.length} expanding histograms — momentum fading` : `✅ ${macd.filter(x => x.histogramExpanding).length} expanding — momentum intact`}</li><li>${topLS[1] > topGS[1] ? `⚠️ More stocks in declining sector (${topLS[0]}: ${topLS[1]}) than gaining (${topGS[0]}: ${topGS[1]})` : `✅ Gaining sector is broader`}</li></ul><h2>Key Levels</h2><ul>${g5.slice(0, 3).map(x => `<li>${x.symbol}: Support Rs. ${x.low}, Resistance Rs. ${x.high}</li>`).join("")}</ul><h2>Verdict</h2><p>${gainers.length > losers.length && macdAboveZero.length > macd.length * 0.5 ? "Evidence tilts toward BREAKOUT — positive breadth and majority MACD above zero support upside." : gainers.length < losers.length && macdAboveZero.length < macd.length * 0.5 ? "Evidence tilts toward CORRECTION — negative breadth and weak MACD suggest further downside risk." : "NEUTRAL — mixed signals suggest consolidation rather than a clear directional move."}</p>`,
      quick_answer: intro[6], category_id: 3, tags: ["56", "55", "22"],
      meta_title: `NEPSE ${today}: Breakout or Correction? Daily Analysis`,
      meta_description: `NEPSE ${today}: ${gainers.length > losers.length ? "Breakout signals" : "Correction signals"} dominant. ${macdAboveZero.length}/${macd.length} MACD above zero. RSI and breadth analysis.`,
      secondary_keywords: [`NEPSE breakout correction ${today}`, "NEPSE market direction", "NEPSE trend today", "Nepal stock breakout", "NEPSE correction analysis"],
      bullet_key_points: [`Breadth: ${gainers.length} vs ${losers.length} (${breadth})`, `MACD above zero: ${macdAboveZero.length}/${macd.length}`, `Bullish vs Bearish crosses: ${macdBullish.length} vs ${macdBearish.length}`, `Bearish divergences: ${rsi.filter(x => x.bearishDivergence).length}`, `Expanding histograms: ${macd.filter(x => x.histogramExpanding).length}`, `Verdict: ${gainers.length > losers.length && macdAboveZero.length > macd.length * 0.5 ? "Breakout" : "Correction/Consolidation"}`],
      faqs: [{ question: "Is NEPSE breaking out or correcting?", answer: `${gainers.length > losers.length && macdAboveZero.length > macd.length * 0.5 ? "Breakout signals dominate" : "Correction/consolidation signals present"} — breadth ${breadth}, ${macdAboveZero.length}/${macd.length} MACD positive.` }],
      entity_tags: ["NEPSE", "breakout", "correction", "MACD", "RSI", "trend analysis"]
    },

    // 8. Top Stocks, Volume Leaders & Sentiment
    {
      title: `NEPSE Today Update (${today}): Top Stocks Volume Leaders and Market Sentiment`,
      content: `<p>${intro[7]}</p><h2>NEPSE Update — ${today}</h2><p>${idxLine}</p><h2>Today's Top Stocks</h2><h3>Gainers</h3>${table(th, g5.map(row))}<h3>Losers</h3>${table(th, l5.map(row))}<h2>Volume Leaders</h2>${table(th, t5.map(row))}<h2>Market Sentiment Assessment</h2><ul><li><strong>Breadth:</strong> ${gainers.length} up vs ${losers.length} down — ${breadth} (A/D: ${adRatio})</li><li><strong>RSI Mood:</strong> ${rsiBuy.length} Buy, ${rsiHold.length} Hold — ${rsiBuy.length > 3 ? "Optimistic" : "Cautious"}</li><li><strong>MACD Mood:</strong> ${macdAboveZero.length}/${macd.length} above zero — ${macdAboveZero.length > macd.length / 2 ? "Bullish" : "Bearish"}</li><li><strong>Volume Mood:</strong> ${t.filter(x => Number(x.percentagechange) > 0).length}/${t.length} turnover leaders gaining — ${t.filter(x => Number(x.percentagechange) > 0).length > t.length / 2 ? "Accumulation" : "Distribution"}</li></ul><h2>Overall Sentiment: ${breadth === "positive" && macdAboveZero.length > macd.length / 2 ? "BULLISH" : breadth === "negative" && macdAboveZero.length < macd.length / 2 ? "BEARISH" : "NEUTRAL"}</h2><p>Based on breadth, RSI, MACD, and volume data, today's market sentiment is ${breadth === "positive" && macdAboveZero.length > macd.length / 2 ? "bullish — buying interest across multiple indicators" : breadth === "negative" ? "bearish — selling pressure dominating" : "neutral — mixed signals across indicators"}.</p>`,
      quick_answer: intro[7], category_id: 3, tags: ["56", "55", "22"],
      meta_title: `NEPSE Update ${today}: Top Stocks Volume & Sentiment`,
      meta_description: `NEPSE ${today}: Sentiment ${breadth === "positive" ? "bullish" : "cautious"}. ${g[0]?.symbol} top gainer, ${t[0]?.symbol} volume leader. RSI and MACD mood check.`,
      secondary_keywords: [`NEPSE update ${today}`, "NEPSE market sentiment", "NEPSE volume leaders", "Nepal stock top picks", "NEPSE sentiment analysis"],
      bullet_key_points: [`Sentiment: ${breadth === "positive" && macdAboveZero.length > macd.length / 2 ? "BULLISH" : "CAUTIOUS"}`, `Top gainer: ${g[0]?.symbol}`, `Volume leader: ${t[0]?.symbol}`, `RSI Buy signals: ${rsiBuy.length}`, `MACD above zero: ${macdAboveZero.length}/${macd.length}`, `A/D Ratio: ${adRatio}`],
      faqs: [{ question: "What is NEPSE sentiment today?", answer: `${breadth === "positive" && macdAboveZero.length > macd.length / 2 ? "Bullish" : "Cautious"} — breadth ${breadth}, ${macdAboveZero.length}/${macd.length} MACD positive, ${rsiBuy.length} RSI Buy signals.` }],
      entity_tags: ["NEPSE", "sentiment", "volume", g[0]?.symbol, t[0]?.symbol]
    },

    // 9. Candlestick Pattern & Key Levels
    {
      title: `NEPSE Daily Report Nepal (${today}): Candlestick Pattern and Key Levels Explained`,
      content: `<p>${intro[8]}</p><h2>NEPSE Key Levels & Price Action — ${today}</h2><p>${idxLine}</p><p>Understanding price action through today's OHLC data and key support/resistance levels.</p><h2>Top Gainers — OHLC Analysis</h2><table><thead><tr><th>Symbol</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Pattern</th></tr></thead><tbody>${g5.map(x => `<tr><td>${x.symbol}</td><td>${x.open}</td><td>${x.high}</td><td>${x.low}</td><td>${x.latesttransactionprice}</td><td>${Number(x.high) === Number(x.latesttransactionprice) ? "Closed at High (Strong)" : Number(x.latesttransactionprice) > ((Number(x.high) + Number(x.low)) / 2) ? "Upper Half Close (Bullish)" : "Lower Half Close (Weak)"}</td></tr>`).join("")}</tbody></table><h2>Top Losers — OHLC Analysis</h2><table><thead><tr><th>Symbol</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Pattern</th></tr></thead><tbody>${l5.map(x => `<tr><td>${x.symbol}</td><td>${x.open}</td><td>${x.high}</td><td>${x.low}</td><td>${x.latesttransactionprice}</td><td>${Number(x.low) === Number(x.latesttransactionprice) ? "Closed at Low (Weak)" : Number(x.latesttransactionprice) < ((Number(x.high) + Number(x.low)) / 2) ? "Lower Half Close (Bearish)" : "Upper Half Close (Recovery)"}</td></tr>`).join("")}</tbody></table><h2>Key Support & Resistance Levels</h2><ul>${g5.slice(0, 4).map(x => `<li><strong>${x.symbol}:</strong> Support: Rs. ${x.low} | Resistance: Rs. ${x.high} | Prev Close: Rs. ${x.previousclosing}</li>`).join("")}${l5.slice(0, 4).map(x => `<li><strong>${x.symbol}:</strong> Support: Rs. ${x.low} | Resistance: Rs. ${x.high} | Prev Close: Rs. ${x.previousclosing}</li>`).join("")}</ul><h2>Reading the Patterns</h2><ul><li><strong>Close at High:</strong> ${g.filter(x => Number(x.high) === Number(x.latesttransactionprice)).length} stocks — strong buying, likely continuation</li><li><strong>Close at Low:</strong> ${l.filter(x => Number(x.low) === Number(x.latesttransactionprice)).length} stocks — persistent selling</li><li><strong>Long lower shadow (hammer):</strong> Stocks that opened low but recovered — potential reversal signals</li></ul><h2>Conclusion</h2><p>OHLC data reveals conviction levels. Stocks closing at highs (like ${g.filter(x => Number(x.high) === Number(x.latesttransactionprice))[0]?.symbol || g[0]?.symbol}) show strong demand, while those at lows indicate supply pressure. Use these levels for next-session trading decisions.</p>`,
      quick_answer: intro[8], category_id: 3, tags: ["56", "55", "22"],
      meta_title: `NEPSE Daily Report ${today}: OHLC Key Levels & Price Action`,
      meta_description: `NEPSE ${today}: OHLC analysis of top movers. ${g.filter(x => Number(x.high) === Number(x.latesttransactionprice)).length} stocks closed at high. Support resistance levels for key stocks.`,
      secondary_keywords: [`NEPSE key levels ${today}`, "NEPSE candlestick pattern", "NEPSE OHLC analysis", "Nepal stock support resistance", "NEPSE price action"],
      bullet_key_points: [`Closed at high: ${g.filter(x => Number(x.high) === Number(x.latesttransactionprice)).length} stocks`, `Closed at low: ${l.filter(x => Number(x.low) === Number(x.latesttransactionprice)).length} stocks`, `${g[0]?.symbol} range: Rs.${g[0]?.low}-${g[0]?.high}`, `${l[0]?.symbol} range: Rs.${l[0]?.low}-${l[0]?.high}`, "OHLC reveals conviction levels", "Key levels for next session set"],
      faqs: [{ question: "What are key levels for NEPSE stocks?", answer: `Top gainer ${g[0]?.symbol}: Support Rs. ${g[0]?.low}, Resistance Rs. ${g[0]?.high}. Top loser ${l[0]?.symbol}: Support Rs. ${l[0]?.low}, Resistance Rs. ${l[0]?.high}.` }],
      entity_tags: ["NEPSE", "OHLC", "candlestick", "key levels", "support resistance", g[0]?.symbol, l[0]?.symbol]
    },

    // 10. Banking, Hydropower & Finance Sector
    {
      title: `NEPSE Closing Analysis (${today}): Banking Hydropower and Finance Sector Performance`,
      content: `<p>${intro[9]}</p><h2>Sector Deep Dive: Banking, Hydropower & Finance — ${today}</h2><p>${idxLine}</p><p>${sectorIdxLine}</p><h2>MACD Market Overview</h2><ul><li>Total stocks analyzed: ${macdTotalStocks}</li><li>Buy signals: ${macdBuyCount} | Hold: ${macdHoldCount} | Avoid: ${macdAvoidCount}</li><li>Leaders: ${macdLeaderCount} stocks</li><li>Bullish crosses: ${macdStats.bullishCross || 0} | Bearish: ${macdStats.bearishCross || 0}</li><li>Above zero line: ${macdStats.aboveZeroLine || 0}</li><li>Volume confirmed: ${macdStats.volumeConfirmed || 0}</li></ul><h2>MACD Status Breakdown</h2>${table(statusTh, sectorRows)}<h2>Top MACD Stocks</h2><ul>${macdTop3.map(s => '<li><strong>' + s.symbol + '</strong> (' + (s.sector||'') + '): Score ' + s.totalScore + ' — ' + s.decision + '. ' + (s.explanation||'') + '</li>').join("")}</ul><h2>Price Action by Sector</h2><ul><li>Banking gainers: ${gainerSectors["COMMERCIAL BANKS"] || 0} | Losers: ${loserSectors["COMMERCIAL BANKS"] || 0}</li><li>Hydropower gainers: ${gainerSectors["HYDROPOWER"] || 0} | Losers: ${loserSectors["HYDROPOWER"] || 0}</li><li>Finance gainers: ${gainerSectors["FINANCE"] || 0} | Losers: ${loserSectors["FINANCE"] || 0}</li></ul><h2>Conclusion</h2><p>${macdTop3[0]?.symbol || "N/A"} leads with MACD score of ${macdTop3[0]?.totalScore || 0}. ${macdLeaderCount} stocks have Leader-level momentum. Focus on ${macdTop3.map(s=>s.symbol).join(", ")} as top technical picks.</p>`,
      quick_answer: intro[9], category_id: 3, tags: ["56", "55", "22"],
      meta_title: `NEPSE ${today}: Banking Hydropower Finance Sector Analysis`,
      meta_description: `NEPSE sectors ${today}: Banking MACD ${(macdTop3[0]?.totalScore || 0)}, Hydropower ${(macdTop3[1]?.totalScore || 0)}, Finance ${(macdTop3[2]?.totalScore || 0)}. Top stocks and momentum analysis.`,
      secondary_keywords: [`NEPSE banking sector ${today}`, "NEPSE hydropower analysis", "NEPSE finance sector", "Nepal bank stocks today", "NEPSE sector MACD"],
      bullet_key_points: [`Banking: ${(macdTop3[0]?.totalScore || 0)} avg, top ${(macdTop3[0]?.symbol || "N/A")}`, `Hydropower: ${(macdTop3[1]?.totalScore || 0)} avg, top ${(macdTop3[1]?.symbol || "N/A")}`, `Finance: ${(macdTop3[2]?.totalScore || 0)} avg, top ${(macdTop3[2]?.symbol || "N/A")}`, `Banking gainers: ${gainerSectors["COMMERCIAL BANKS"] || 0}`, `Hydro gainers: ${gainerSectors["HYDROPOWER"] || 0}`, `Best sector: ${(macdTop3[0]?.sector || topGS[0])}`],
      faqs: [{ question: "Which sector is best today?", answer: `${(macdTop3[0]?.sector || topGS[0])} has the highest MACD momentum score.` }],
      entity_tags: ["NEPSE", "Banking", "Hydropower", "Finance", (macdTop3[0]?.symbol || "N/A"), (macdTop3[1]?.symbol || "N/A")]
    },

    // 11. Market Trend & Next Day Prediction
    {
      title: `NEPSE Today News (${today}): Market Trend Investor Sentiment and Next Day Prediction`,
      content: `<p>${intro[10]}</p><h2>NEPSE Trend & Prediction — ${today}</h2><p>${idxLine}</p><h2>Today's Trend Summary</h2><ul><li>Breadth: ${breadth} (${gainers.length} up, ${losers.length} down)</li><li>MACD above zero: ${macdAboveZero.length}/${macd.length} (${(macdAboveZero.length/macd.length*100).toFixed(0)}%)</li><li>RSI Buy signals: ${rsiBuy.length}</li><li>Expanding MACD histograms: ${macd.filter(x=>x.histogramExpanding).length}</li></ul><h2>Investor Sentiment Score</h2><p>Composite: ${((gainers.length > losers.length ? 1 : 0) + (macdAboveZero.length > macd.length/2 ? 1 : 0) + (macdBullish.length > macdBearish.length ? 1 : 0) + (rsiBuy.length > 2 ? 1 : 0))} / 4 signals bullish → <strong>${((gainers.length > losers.length ? 1 : 0) + (macdAboveZero.length > macd.length/2 ? 1 : 0) + (macdBullish.length > macdBearish.length ? 1 : 0) + (rsiBuy.length > 2 ? 1 : 0)) >= 3 ? "BULLISH" : ((gainers.length > losers.length ? 1 : 0) + (macdAboveZero.length > macd.length/2 ? 1 : 0) + (macdBullish.length > macdBearish.length ? 1 : 0) + (rsiBuy.length > 2 ? 1 : 0)) <= 1 ? "BEARISH" : "NEUTRAL"}</strong></p><h2>Next Day Prediction</h2><p>${gainers.length > losers.length ? `Positive breadth and ${topGS[0]} sector strength suggest continued buying interest. Watch ${g[0]?.symbol} and ${g[1]?.symbol} for follow-through.` : `Negative breadth suggests selling may continue. Watch ${l[0]?.symbol} and ${l[1]?.symbol} for support levels — a bounce from today's lows would be constructive.`}</p><p>Key stocks for tomorrow: ${rsi5.slice(0, 3).map(x => `${x.symbol} (RSI ${x.decision})`).join(", ")}. Volume watchlist: ${t5.slice(0, 3).map(x => x.symbol).join(", ")}.</p>`,
      quick_answer: intro[10], category_id: 3, tags: ["56", "55", "22"],
      meta_title: `NEPSE ${today}: Trend Sentiment & Next Day Prediction`,
      meta_description: `NEPSE ${today}: Sentiment ${((gainers.length > losers.length ? 1 : 0) + (macdAboveZero.length > macd.length/2 ? 1 : 0)) >= 2 ? "bullish" : "cautious"}. Next day prediction based on breadth, RSI, and MACD signals.`,
      secondary_keywords: [`NEPSE prediction ${today}`, "NEPSE tomorrow forecast", "NEPSE investor sentiment", "Nepal stock market prediction", "NEPSE next day outlook"],
      bullet_key_points: [`Breadth: ${breadth}`, `MACD positive: ${(macdAboveZero.length/macd.length*100).toFixed(0)}%`, `RSI Buy: ${rsiBuy.length}`, `Watch: ${g[0]?.symbol}, ${t[0]?.symbol}`, `${topGS[0]} sector strongest`, "Combine signals for conviction"],
      faqs: [{ question: "What will NEPSE do tomorrow?", answer: `${gainers.length > losers.length ? "Positive breadth suggests continuation. Watch " + g[0]?.symbol + " for follow-through." : "Negative breadth suggests caution. Watch for support at " + l[0]?.symbol + " lows."}` }],
      entity_tags: ["NEPSE", "prediction", "sentiment", "next day", g[0]?.symbol, rsi[0]?.symbol]
    },

    // 12. Daily Closing Data & Technical Signals
    {
      title: `NEPSE Live Market Summary (${today}): Daily Closing Data and Technical Signals`,
      content: `<p>${intro[11]}</p><h2>NEPSE Closing Data & Technicals — ${today}</h2><p>${idxLine}</p><h2>Market Data</h2><ul><li>Advancing: ${gainers.length} | Declining: ${losers.length}</li><li>A/D Ratio: ${adRatio}</li><li>Top Gainer: ${g[0]?.symbol} +${Number(g[0]?.percentagechange).toFixed(2)}%</li><li>Top Loser: ${l[0]?.symbol} ${Number(l[0]?.percentagechange).toFixed(2)}%</li><li>Volume Leader: ${t[0]?.symbol} (${Number(t[0]?.volume).toLocaleString()})</li></ul><h2>RSI Technical Signals</h2>${table(rsiTh, rsi5.map(rsiRow))}<h2>MACD Technical Signals</h2>${table(macdTh, macd5.map(macdRow))}<h2>Signal Summary</h2><table><thead><tr><th>Signal</th><th>Count</th><th>Meaning</th></tr></thead><tbody><tr><td>RSI Buy</td><td>${rsiBuy.length}</td><td>Stocks with buying momentum</td></tr><tr><td>MACD Bullish Cross</td><td>${macdBullish.length}</td><td>Fresh uptrend signal</td></tr><tr><td>MACD Bearish Cross</td><td>${macdBearish.length}</td><td>Downtrend warning</td></tr><tr><td>Above MACD Zero</td><td>${macdAboveZero.length}/${macd.length}</td><td>Overall momentum direction</td></tr><tr><td>Volume Confirmed</td><td>${macd.filter(x=>x.volumeConfirmed).length}</td><td>Strong conviction moves</td></tr><tr><td>Bullish Divergence</td><td>${rsi.filter(x=>x.bullishDivergence).length}</td><td>Potential reversal up</td></tr><tr><td>Bearish Divergence</td><td>${rsi.filter(x=>x.bearishDivergence).length}</td><td>Potential reversal down</td></tr></tbody></table>`,
      quick_answer: intro[11], category_id: 3, tags: ["56", "55", "22"],
      meta_title: `NEPSE Closing Data ${today}: RSI MACD Technical Signals`,
      meta_description: `NEPSE ${today}: ${rsiBuy.length} RSI Buy, ${macdBullish.length} bullish crosses, ${macdAboveZero.length}/${macd.length} MACD positive. Complete data and technical signal summary.`,
      secondary_keywords: [`NEPSE closing data ${today}`, "NEPSE technical signals", "NEPSE RSI signals today", "NEPSE MACD today", "Nepal market technicals"],
      bullet_key_points: [`RSI Buy: ${rsiBuy.length}`, `MACD Bullish cross: ${macdBullish.length}`, `MACD above zero: ${macdAboveZero.length}/${macd.length}`, `Bullish divergence: ${rsi.filter(x=>x.bullishDivergence).length}`, `Bearish divergence: ${rsi.filter(x=>x.bearishDivergence).length}`, `Volume confirmed: ${macd.filter(x=>x.volumeConfirmed).length}`],
      faqs: [{ question: "What technical signals appeared today?", answer: `${rsiBuy.length} RSI Buy, ${macdBullish.length} MACD bullish crosses, ${rsi.filter(x=>x.bullishDivergence).length} bullish divergences. ${macdAboveZero.length}/${macd.length} stocks above MACD zero.` }],
      entity_tags: ["NEPSE", "technical signals", "RSI", "MACD", "divergence", "closing data"]
    },

    // 13. Index, Liquidity & Smart Money Flow
    {
      title: `Nepal Stock Market Closing Report (${today}): Index Liquidity and Smart Money Flow`,
      content: `<p>${intro[12]}</p><h2>Closing Report: Liquidity & Smart Money — ${today}</h2><p>${idxLine}</p><h2>Liquidity Analysis</h2><ul><li>Top turnover stocks: ${t5.map(x => x.symbol).join(", ")}</li><li>Volume leader: ${t[0]?.symbol} — ${Number(t[0]?.volume).toLocaleString()} shares (Rs. ${(Number(t[0]?.turnover || 0)/1e6).toFixed(1)}M)</li><li>Volume-confirmed MACD moves: ${macd.filter(x=>x.volumeConfirmed).length} stocks</li></ul><h2>Smart Money Signals</h2>${table(th, t5.map(row))}<ul>${t5.map(x => `<li>${x.symbol}: ${Number(x.percentagechange) > 0 ? "📈 Price UP + High Volume = ACCUMULATION" : Number(x.percentagechange) < 0 ? "📉 Price DOWN + High Volume = DISTRIBUTION" : "➡️ Flat + Volume = CHURNING"}</li>`).join("")}</ul><h2>Market Breadth</h2><ul><li>${gainers.length} advancing (${(gainers.length/(gainers.length+losers.length)*100).toFixed(0)}%) vs ${losers.length} declining</li><li>A/D Ratio: ${adRatio}</li></ul><h2>Conclusion</h2><p>Liquidity was concentrated in ${t[0]?.sector} (${t[0]?.symbol}) and ${t[1]?.sector} (${t[1]?.symbol}). ${t.filter(x => Number(x.percentagechange) > 0).length} of top 10 turnover stocks ended positive — ${t.filter(x => Number(x.percentagechange) > 0).length > 5 ? "smart money favored buying" : "distribution outweighed accumulation"}.</p>`,
      quick_answer: intro[12], category_id: 3, tags: ["56", "55", "22"],
      meta_title: `Nepal Stock Market ${today}: Liquidity & Smart Money Analysis`,
      meta_description: `NEPSE ${today}: ${t[0]?.symbol} volume leader. ${t.filter(x=>Number(x.percentagechange)>0).length}/10 turnover stocks positive. Smart money flow and liquidity analysis.`,
      secondary_keywords: [`NEPSE liquidity ${today}`, "NEPSE smart money flow", "Nepal stock market closing", "NEPSE volume analysis", "NEPSE accumulation distribution"],
      bullet_key_points: [`Volume leader: ${t[0]?.symbol}`, `${t.filter(x=>Number(x.percentagechange)>0).length}/10 turnover stocks up`, `Volume confirmed: ${macd.filter(x=>x.volumeConfirmed).length}`, `Breadth: ${adRatio} A/D`, `Smart money in ${t[0]?.sector}`, `${breadth} overall flow`],
      faqs: [{ question: "Where did smart money flow today?", answer: `${t[0]?.symbol} (${Number(t[0]?.volume).toLocaleString()} shares) — ${Number(t[0]?.percentagechange) > 0 ? "accumulation" : "distribution"} signal. ${t.filter(x=>Number(x.percentagechange)>0).length}/10 volume leaders positive.` }],
      entity_tags: ["NEPSE", "smart money", "liquidity", t[0]?.symbol, t[1]?.symbol]
    },

    // 14. Support Resistance & Trend Direction
    {
      title: `NEPSE Today Analysis (${today}): Support Resistance and Trend Direction Nepal`,
      content: `<p>${intro[13]}</p><h2>NEPSE Support, Resistance & Trend — ${today}</h2><p>${idxLine}</p><h2>Key Levels for Top Movers</h2><table><thead><tr><th>Symbol</th><th>Support (Low)</th><th>Resistance (High)</th><th>Close</th><th>Prev Close</th><th>Trend</th></tr></thead><tbody>${g5.concat(l5).map(x => `<tr><td>${x.symbol}</td><td>Rs. ${x.low}</td><td>Rs. ${x.high}</td><td>Rs. ${x.latesttransactionprice}</td><td>Rs. ${x.previousclosing}</td><td>${Number(x.percentagechange) > 0 ? "Bullish" : "Bearish"}</td></tr>`).join("")}</tbody></table><h2>RSI Trend Direction</h2><ul>${rsi5.map(x => `<li>${x.symbol}: RSI ${x.rsi14.toFixed(1)} — ${x.rsiAbove60 ? "Strong uptrend (above 60)" : x.rsiAbove50 ? "Mild uptrend (above 50)" : "Downtrend (below 50)"}. ${x.rsiMakingHigherLows ? "Making higher lows ✅" : ""} ${x.bearishDivergence ? "⚠️ Bearish divergence" : ""}</li>`).join("")}</ul><h2>MACD Trend Direction</h2><ul>${macd5.map(x => `<li>${x.symbol}: MACD ${x.macdLine.toFixed(2)} — ${x.aboveZeroLine ? "Bullish territory" : "Bearish territory"}. Momentum: ${x.momentumState}. ${x.bullishCross ? "🟢 Fresh bullish cross" : ""} ${x.bearishCross ? "🔴 Bearish cross" : ""}</li>`).join("")}</ul><h2>Overall Trend Assessment</h2><p>${macdAboveZero.length > macd.length * 0.6 ? "Broad uptrend — 60%+ stocks have MACD above zero." : macdAboveZero.length < macd.length * 0.4 ? "Broad downtrend — less than 40% MACD positive." : "Sideways/transitional — mixed MACD signals."} Key support levels to watch: ${l5.slice(0,3).map(x => `${x.symbol} at Rs. ${x.low}`).join(", ")}.</p>`,
      quick_answer: intro[13], category_id: 3, tags: ["56", "55", "22"],
      meta_title: `NEPSE ${today}: Support Resistance & Trend Direction`,
      meta_description: `NEPSE ${today}: Key support/resistance for ${g[0]?.symbol}, ${l[0]?.symbol}. RSI and MACD trend analysis. ${macdAboveZero.length}/${macd.length} in uptrend.`,
      secondary_keywords: [`NEPSE support resistance ${today}`, "NEPSE trend direction", "Nepal stock levels", "NEPSE technical levels", "NEPSE trend analysis today"],
      bullet_key_points: [`${g[0]?.symbol}: Support ${g[0]?.low}, Resistance ${g[0]?.high}`, `${l[0]?.symbol}: Support ${l[0]?.low}`, `MACD uptrend: ${macdAboveZero.length}/${macd.length}`, `Top RSI: ${rsi[0]?.symbol} at ${rsi[0]?.rsi14.toFixed(1)}`, `Bullish crosses: ${macdBullish.length}`, `Trend: ${macdAboveZero.length > macd.length * 0.5 ? "Bullish" : "Cautious"}`],
      faqs: [{ question: "What are key NEPSE levels today?", answer: `${g[0]?.symbol} support Rs. ${g[0]?.low}, resistance Rs. ${g[0]?.high}. ${l[0]?.symbol} key support at Rs. ${l[0]?.low}. Break below triggers further downside.` }],
      entity_tags: ["NEPSE", "support", "resistance", "trend", "RSI", "MACD", g[0]?.symbol, l[0]?.symbol]
    },

    // 15. Which Stocks Led the Market?
    {
      title: `NEPSE Daily Wrap (${today}): Which Stocks Led the Market Today in Nepal`,
      content: `<p>${intro[14]}</p><h2>Market Leaders — ${today}</h2><p>${idxLine}</p><p>Every trading day, a few stocks define the market direction. Here are today's leaders across categories.</p><h2>Price Leaders (Gainers)</h2>${table(th, g5.map(row))}<h2>Decline Leaders (Losers)</h2>${table(th, l5.map(row))}<h2>Volume Leaders</h2>${table(th, t5.map(row))}<h2>Technical Leaders (RSI)</h2><ul>${rsi5.map(x => `<li>${x.symbol}: RSI Score ${x.totalScore.toFixed(1)} (${x.category}/${x.decision}) — ${x.explanation || ""}</li>`).join("")}</ul><h2>MACD Leaders</h2><ul>${macd5.map(x => `<li>${x.symbol}: MACD Score ${x.totalScore} (${x.macdStatus}/${x.decision}) — ${x.explanation || ""}</li>`).join("")}</ul><h2>The Day's MVP</h2><p>${g[0]?.symbol} leads on price (+${Number(g[0]?.percentagechange).toFixed(2)}%). ${t[0]?.symbol} leads on volume (${Number(t[0]?.volume).toLocaleString()}). ${rsi[0]?.symbol} leads on RSI score (${rsi[0]?.totalScore.toFixed(1)}). These are the stocks that moved the market today.</p>`,
      quick_answer: intro[14], category_id: 3, tags: ["56", "55", "22"],
      meta_title: `NEPSE ${today}: Which Stocks Led the Market Today`,
      meta_description: `NEPSE leaders ${today}: Price ${g[0]?.symbol} +${Number(g[0]?.percentagechange).toFixed(2)}%, Volume ${t[0]?.symbol}, RSI ${rsi[0]?.symbol}. Full market leadership analysis.`,
      secondary_keywords: [`NEPSE leaders ${today}`, "NEPSE top stocks today", "Nepal stock market leaders", "NEPSE daily wrap", "which stocks led NEPSE"],
      bullet_key_points: [`Price leader: ${g[0]?.symbol} +${Number(g[0]?.percentagechange).toFixed(2)}%`, `Volume leader: ${t[0]?.symbol}`, `RSI leader: ${rsi[0]?.symbol} (${rsi[0]?.totalScore.toFixed(1)})`, `MACD leader: ${macd[0]?.symbol} (${macd[0]?.totalScore})`, `Biggest decliner: ${l[0]?.symbol}`, `Top sector: ${topGS[0]}`],
      faqs: [{ question: "Which stock led NEPSE today?", answer: `${g[0]?.symbol} led on price (+${Number(g[0]?.percentagechange).toFixed(2)}%), ${t[0]?.symbol} on volume, and ${rsi[0]?.symbol} on RSI technical strength.` }],
      entity_tags: ["NEPSE", "market leaders", g[0]?.symbol, t[0]?.symbol, rsi[0]?.symbol, l[0]?.symbol]
    },

    // 16. Profit Booking or Fresh Buying?
    {
      title: `NEPSE Today Closing (${today}): Profit Booking or Fresh Buying Full Breakdown`,
      content: `<p>${intro[15]}</p><h2>Profit Booking or Fresh Buying? — ${today}</h2><p>${idxLine}</p><p>Was today's action driven by profit booking or fresh buying? The data reveals the answer.</p><h2>Evidence for Fresh Buying</h2><ul><li>${gainers.length > losers.length ? `✅ More gainers (${gainers.length}) than losers (${losers.length})` : `❌ Losers outnumber gainers`}</li><li>${macdBullish.length > 0 ? `✅ ${macdBullish.length} fresh MACD bullish crosses — new buying signals` : "❌ No fresh bullish crosses"}</li><li>${g.filter(x => Number(x.volume) > 10000).length > 0 ? `✅ ${g.filter(x => Number(x.volume) > 10000).length} high-volume gainers — conviction buying` : "❌ Thin volume on gains"}</li><li>${rsi.filter(x => x.rsiMakingHigherLows).length > 5 ? `✅ ${rsi.filter(x => x.rsiMakingHigherLows).length} stocks making higher RSI lows — underlying strength` : `⚠️ Only ${rsi.filter(x => x.rsiMakingHigherLows).length} making higher lows`}</li></ul><h2>Evidence for Profit Booking</h2><ul><li>${losers.length > gainers.length ? `⚠️ More decliners (${losers.length}) — selling pressure` : "✅ Limited selling"}</li><li>${macdBearish.length > 0 ? `⚠️ ${macdBearish.length} MACD bearish crosses — exit signals triggered` : "✅ No bearish crosses"}</li><li>${l.filter(x => Number(x.volume) > 10000).length > 0 ? `⚠️ ${l.filter(x => Number(x.volume) > 10000).length} high-volume losers — conviction selling` : "✅ Low volume on declines"}</li><li>${rsi.filter(x => x.bearishDivergence).length > 3 ? `⚠️ ${rsi.filter(x => x.bearishDivergence).length} bearish divergences — hidden weakness` : "✅ Limited divergence"}</li></ul><h2>Verdict</h2><p>${gainers.length > losers.length && macdBullish.length >= macdBearish.length ? "Fresh buying appears dominant — positive breadth and bullish technical signals outweigh selling evidence." : losers.length > gainers.length && macdBearish.length > macdBullish.length ? "Profit booking dominated — selling pressure across breadth and technical indicators." : "Mixed — both buying and selling present. Market in a transition phase."}</p>`,
      quick_answer: intro[15], category_id: 3, tags: ["56", "55", "22"],
      meta_title: `NEPSE ${today}: Profit Booking or Fresh Buying? Breakdown`,
      meta_description: `NEPSE ${today}: ${gainers.length > losers.length ? "Fresh buying dominant" : "Profit booking evident"}. ${macdBullish.length} bullish vs ${macdBearish.length} bearish crosses. Full breakdown.`,
      secondary_keywords: [`NEPSE profit booking ${today}`, "NEPSE fresh buying", "NEPSE buying selling analysis", "Nepal stock market flow", "NEPSE accumulation today"],
      bullet_key_points: [`${gainers.length > losers.length ? "Fresh buying dominant" : "Profit booking present"}`, `Bullish crosses: ${macdBullish.length}`, `Bearish crosses: ${macdBearish.length}`, `High-vol gainers: ${g.filter(x=>Number(x.volume)>10000).length}`, `High-vol losers: ${l.filter(x=>Number(x.volume)>10000).length}`, `Bearish divergences: ${rsi.filter(x=>x.bearishDivergence).length}`],
      faqs: [{ question: "Was today profit booking or fresh buying?", answer: `${gainers.length > losers.length && macdBullish.length >= macdBearish.length ? "Fresh buying dominated" : "Profit booking was evident"} — ${gainers.length} gainers vs ${losers.length} losers, ${macdBullish.length} bullish vs ${macdBearish.length} bearish MACD crosses.` }],
      entity_tags: ["NEPSE", "profit booking", "fresh buying", "accumulation", "distribution"]
    },

    // 17. Sector Rotation & Key Movers
    {
      title: `NEPSE Market Update (${today}): Sector Rotation and Key Movers Today`,
      content: `<p>${intro[16]}</p><h2>Sector Rotation & Key Movers — ${today}</h2><p>${idxLine}</p><p>${sectorIdxLine}</p><h2>Sector Rotation Map</h2><h3>Money Flowing INTO (Gaining Sectors)</h3><ul>${Object.entries(gainerSectors).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([s, c]) => `<li><strong>${s}:</strong> ${c} stocks gaining</li>`).join("")}</ul><h3>Money Flowing OUT (Declining Sectors)</h3><ul>${Object.entries(loserSectors).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([s, c]) => `<li><strong>${s}:</strong> ${c} stocks declining</li>`).join("")}</ul><h2>Key Movers</h2><table><thead><tr><th>Category</th><th>Stock</th><th>Move</th><th>Volume</th></tr></thead><tbody><tr><td>Top Gainer</td><td>${g[0]?.symbol}</td><td>+${Number(g[0]?.percentagechange).toFixed(2)}%</td><td>${Number(g[0]?.volume).toLocaleString()}</td></tr><tr><td>Top Loser</td><td>${l[0]?.symbol}</td><td>${Number(l[0]?.percentagechange).toFixed(2)}%</td><td>${Number(l[0]?.volume).toLocaleString()}</td></tr><tr><td>Most Volume</td><td>${t[0]?.symbol}</td><td>${Number(t[0]?.percentagechange).toFixed(2)}%</td><td>${Number(t[0]?.volume).toLocaleString()}</td></tr><tr><td>Top RSI</td><td>${rsi[0]?.symbol}</td><td>Score: ${rsi[0]?.totalScore.toFixed(1)}</td><td>${rsi[0]?.decision}</td></tr><tr><td>Top MACD</td><td>${macd[0]?.symbol}</td><td>Score: ${macd[0]?.totalScore}</td><td>${macd[0]?.decision}</td></tr></tbody></table><h2>MACD Sector Momentum</h2><ul>${macdStatuses.map(s => `<li>${s.status}: ${s.count} stocks, Avg ${s.avgScore.toFixed(1)} — Range ${s.minScore}-${s.maxScore}</li>`).join("")}</ul><h2>Conclusion</h2><p>Rotation from ${topLS[0]} → ${topGS[0]} defined today. ${topGS[0]} attracted the most buying interest. Key movers ${g[0]?.symbol} and ${t[0]?.symbol} warrant continued monitoring.</p>`,
      quick_answer: intro[16], category_id: 3, tags: ["56", "55", "22"],
      meta_title: `NEPSE ${today}: Sector Rotation & Key Movers`,
      meta_description: `NEPSE ${today}: Money flowing into ${topGS[0]}, out of ${topLS[0]}. ${g[0]?.symbol} top mover. MACD sector rankings and key stock analysis.`,
      secondary_keywords: [`NEPSE sector rotation ${today}`, "NEPSE key movers", "Nepal stock sector flow", "NEPSE money flow sectors", "NEPSE rotation analysis"],
      bullet_key_points: [`Into: ${topGS[0]} (${topGS[1]} stocks)`, `Out of: ${topLS[0]} (${topLS[1]} stocks)`, `Top gainer: ${g[0]?.symbol}`, `Top volume: ${t[0]?.symbol}`, `Top RSI: ${rsi[0]?.symbol}`, `Top MACD sector: ${macdStatuses[0]?.status}`],
      faqs: [{ question: "What sector rotation happened today?", answer: `Money rotated from ${topLS[0]} (${topLS[1]} declining) into ${topGS[0]} (${topGS[1]} gaining). This pattern often continues for 2-3 sessions.` }],
      entity_tags: ["NEPSE", "sector rotation", topGS[0], topLS[0], g[0]?.symbol, t[0]?.symbol]
    },

    // 18. What Investors Should Do Next
    {
      title: `NEPSE Today Report (${today}): What Investors Should Do Next Expert Insight`,
      content: `<p>${intro[17]}</p><h2>What Should You Do Next? — ${today}</h2><p>${idxLine}</p><p>Based on today's complete data — price action, volume, RSI, MACD, and sector momentum — here are actionable insights.</p><h2>If You're Already Invested</h2><ul><li><strong>In ${topGS[0]} stocks:</strong> ${gainers.length > losers.length ? "Hold — sector showing strength, trend intact" : "Consider partial profit booking — market breadth is weakening"}</li><li><strong>In ${topLS[0]} stocks:</strong> ${losers.length > gainers.length ? "Review stops — selling pressure may continue" : "Hold if fundamentals are strong — today may be temporary"}</li><li><strong>In high-RSI stocks:</strong> ${rsi.filter(x => x.rsi14 > 70).length > 0 ? `${rsi.filter(x => x.rsi14 > 70).length} stocks have RSI above 70 — overbought territory. Consider trailing stops.` : "Most stocks in neutral RSI zone — no immediate overbought concern."}</li></ul><h2>If You're Looking to Buy</h2><ul><li><strong>Momentum picks:</strong> ${g5.slice(0, 3).map(x => x.symbol).join(", ")} — riding today's momentum</li><li><strong>Technical picks:</strong> ${rsi5.slice(0, 3).map(x => `${x.symbol} (${x.decision})`).join(", ")} — RSI-backed</li><li><strong>Volume-confirmed:</strong> ${t5.filter(x => Number(x.percentagechange) > 0).slice(0, 3).map(x => x.symbol).join(", ") || "Limited high-volume gainers"}</li></ul><h2>If You're Cautious</h2><ul><li>Bank deposits at ~4.54% remain the safe alternative</li><li>Wait for clear RSI Buy signals (currently: ${rsiBuy.length})</li><li>Watch for MACD bullish crosses as entry triggers</li></ul><h2>Key Numbers for Decision Making</h2><table><thead><tr><th>Signal</th><th>Value</th><th>Interpretation</th></tr></thead><tbody><tr><td>Breadth</td><td>${gainers.length} vs ${losers.length}</td><td>${breadth}</td></tr><tr><td>RSI Buy</td><td>${rsiBuy.length}</td><td>${rsiBuy.length > 3 ? "Multiple opportunities" : "Selective"}</td></tr><tr><td>MACD Bullish</td><td>${macdBullish.length}</td><td>${macdBullish.length > 2 ? "Fresh buying signals" : "Limited new signals"}</td></tr><tr><td>MACD Above Zero</td><td>${(macdAboveZero.length/macd.length*100).toFixed(0)}%</td><td>${macdAboveZero.length > macd.length/2 ? "Broad uptrend" : "Weakening trend"}</td></tr></tbody></table>`,
      quick_answer: intro[17], category_id: 3, tags: ["56", "55", "22"],
      meta_title: `NEPSE ${today}: What Investors Should Do Next`,
      meta_description: `NEPSE ${today} action plan: ${breadth} market. RSI picks: ${rsi5.slice(0,2).map(x=>x.symbol).join(", ")}. Volume picks: ${t5.slice(0,2).map(x=>x.symbol).join(", ")}. Expert investor guide.`,
      secondary_keywords: [`NEPSE what to do ${today}`, "NEPSE investor action", "Nepal stock advice today", "NEPSE buy hold sell", "NEPSE expert insight"],
      bullet_key_points: [`Market: ${breadth}`, `Momentum: ${g5.slice(0,3).map(x=>x.symbol).join(", ")}`, `RSI picks: ${rsi5.slice(0,3).map(x=>x.symbol).join(", ")}`, `RSI Buy signals: ${rsiBuy.length}`, `Safe: deposits at 4.54%`, `Watch MACD crosses for entries`],
      faqs: [{ question: "What should I do after today's NEPSE?", answer: `${breadth === "positive" ? "Hold winners, consider adding to " + topGS[0] + " stocks" : "Review stops on losers, wait for RSI Buy signals before new positions"}. Deposits at 4.54% remain the safe option.` }],
      entity_tags: ["NEPSE", "investor guide", "action plan", rsi[0]?.symbol, g[0]?.symbol, t[0]?.symbol]
    },

    // 19. Market Strength, Weakness & Strategy
    {
      title: `NEPSE Daily Closing Nepal (${today}): Market Strength Weakness and Trading Strategy`,
      content: `<p>${intro[18]}</p><h2>Strength, Weakness & Strategy — ${today}</h2><p>${idxLine}</p><h2>Market Strengths Today</h2><ul><li>${gainers.length > losers.length ? `Breadth positive: ${gainers.length} gainers` : "N/A"}</li><li>${topGS[0]} sector: ${topGS[1]} stocks advancing</li><li>${macdAboveZero.length > macd.length / 2 ? `${macdAboveZero.length}/${macd.length} MACD above zero` : ""}</li><li>Top gainer ${g[0]?.symbol}: +${Number(g[0]?.percentagechange).toFixed(2)}% with ${Number(g[0]?.volume).toLocaleString()} volume</li>${rsiBuy.length > 0 ? `<li>${rsiBuy.length} RSI Buy signals active</li>` : ""}</ul><h2>Market Weaknesses Today</h2><ul><li>${losers.length > gainers.length ? `Breadth negative: ${losers.length} decliners` : ""}</li><li>${topLS[0]} sector: ${topLS[1]} stocks declining</li><li>Bearish divergences: ${rsi.filter(x => x.bearishDivergence).length} stocks</li><li>${macdBearish.length > 0 ? `${macdBearish.length} bearish MACD crosses` : "No bearish crosses"}</li><li>Top loser ${l[0]?.symbol}: ${Number(l[0]?.percentagechange).toFixed(2)}%</li></ul><h2>Trading Strategy for Next Session</h2><ul><li><strong>Aggressive:</strong> Buy ${topGS[0]} sector leaders (${g5.slice(0,2).map(x=>x.symbol).join(", ")}) on any dip to today's support levels</li><li><strong>Moderate:</strong> Watch RSI Buy signals (${rsi.filter(x=>x.decision==="Buy").slice(0,3).map(x=>x.symbol).join(", ") || "none currently"}) for confirmed entries</li><li><strong>Conservative:</strong> Stay in deposits (4.54%) until breadth and MACD signals align bullishly</li></ul><h2>Risk Management</h2><ul><li>Stop-loss: Below today's low for any new positions</li><li>Position size: Max 5-10% per stock</li><li>Sector exposure: Don't overweight ${topGS[0]} despite today's strength</li></ul>`,
      quick_answer: intro[18], category_id: 3, tags: ["56", "55", "22"],
      meta_title: `NEPSE ${today}: Strength Weakness & Trading Strategy`,
      meta_description: `NEPSE ${today}: Strength in ${topGS[0]}, weakness in ${topLS[0]}. RSI Buy: ${rsiBuy.length}. Trading strategies for aggressive, moderate, and conservative investors.`,
      secondary_keywords: [`NEPSE strategy ${today}`, "NEPSE strength weakness", "Nepal stock trading plan", "NEPSE market strategy", "NEPSE risk management"],
      bullet_key_points: [`Strength: ${topGS[0]} (${topGS[1]} stocks)`, `Weakness: ${topLS[0]} (${topLS[1]} stocks)`, `RSI Buy: ${rsiBuy.length}`, `MACD positive: ${macdAboveZero.length}/${macd.length}`, `Aggressive: buy ${topGS[0]} dips`, `Conservative: deposits 4.54%`],
      faqs: [{ question: "What's the best strategy for NEPSE?", answer: `${breadth === "positive" ? "Moderate-aggressive" : "Conservative"} — ${breadth} breadth with ${macdAboveZero.length}/${macd.length} MACD positive. Focus on ${topGS[0]} sector and RSI-backed picks.` }],
      entity_tags: ["NEPSE", "strategy", "strength", "weakness", topGS[0], topLS[0], "risk management"]
    },

    // 20. Full Analysis: Index Movement, Turnover & Tomorrow Outlook
    {
      title: `NEPSE Today Full Analysis (${today}): Index Movement Turnover and Tomorrow Outlook`,
      content: `<p>${intro[19]}</p><h2>NEPSE Full Analysis — ${today}</h2><p>${idxLine}</p><p>${sectorIdxLine}</p><h2>Market Overview</h2><ul><li>Advancing: ${gainers.length} | Declining: ${losers.length} | A/D: ${adRatio}</li><li>Top Gainer: ${g[0]?.symbol} (+${Number(g[0]?.percentagechange).toFixed(2)}%)</li><li>Top Loser: ${l[0]?.symbol} (${Number(l[0]?.percentagechange).toFixed(2)}%)</li><li>Volume Leader: ${t[0]?.symbol} (${Number(t[0]?.volume).toLocaleString()})</li></ul><h2>Top 10 Gainers</h2>${table(th, g.map(row))}<h2>Top 10 Losers</h2>${table(th, l.map(row))}<h2>Top 10 Turnover</h2>${table(th, t.map(row))}<h2>Technical Snapshot</h2><table><thead><tr><th>Signal</th><th>Value</th></tr></thead><tbody><tr><td>RSI Buy Signals</td><td>${rsiBuy.length}</td></tr><tr><td>MACD Bullish Crosses</td><td>${macdBullish.length}</td></tr><tr><td>MACD Above Zero</td><td>${macdAboveZero.length}/${macd.length} (${(macdAboveZero.length/macd.length*100).toFixed(0)}%)</td></tr><tr><td>Bullish Divergence</td><td>${rsi.filter(x=>x.bullishDivergence).length}</td></tr><tr><td>Bearish Divergence</td><td>${rsi.filter(x=>x.bearishDivergence).length}</td></tr><tr><td>Volume Confirmed</td><td>${macd.filter(x=>x.volumeConfirmed).length}</td></tr></tbody></table><h2>Sector Performance</h2>${table(statusTh, sectorRows)}<h2>Tomorrow Outlook</h2><p><strong>${gainers.length > losers.length && macdAboveZero.length > macd.length * 0.5 ? "BULLISH BIAS" : gainers.length < losers.length ? "CAUTIOUS" : "NEUTRAL"}</strong> — ${gainers.length > losers.length ? `Positive breadth (${adRatio} A/D) and ${macdAboveZero.length}/${macd.length} MACD positive support continued buying. Watch ${topGS[0]} for follow-through and ${g[0]?.symbol} for momentum continuation.` : `Negative breadth suggests caution. Watch ${l[0]?.symbol} support at Rs. ${l[0]?.low} — a hold above this level would be constructive.`}</p><p>Stocks to watch: ${rsi5.slice(0,3).map(x => `${x.symbol} (RSI: ${x.decision})`).join(", ")}. Volume watchlist: ${t5.slice(0,3).map(x => x.symbol).join(", ")}.</p>`,
      quick_answer: intro[19], category_id: 3, tags: ["56", "55", "22"],
      meta_title: `NEPSE Full Analysis ${today}: Index Turnover & Tomorrow Outlook`,
      meta_description: `NEPSE ${today} complete: ${gainers.length} up/${losers.length} down. ${g[0]?.symbol} +${Number(g[0]?.percentagechange).toFixed(2)}%. RSI ${rsiBuy.length} Buy. MACD ${macdAboveZero.length}/${macd.length} positive. Tomorrow: ${gainers.length > losers.length ? "bullish" : "cautious"}.`,
      secondary_keywords: [`NEPSE full analysis ${today}`, "NEPSE tomorrow outlook", "Nepal stock complete report", "NEPSE daily analysis full", "NEPSE index turnover analysis"],
      bullet_key_points: [`${gainers.length} up, ${losers.length} down (A/D: ${adRatio})`, `Top: ${g[0]?.symbol} +${Number(g[0]?.percentagechange).toFixed(2)}%`, `Volume: ${t[0]?.symbol}`, `RSI Buy: ${rsiBuy.length}`, `MACD positive: ${(macdAboveZero.length/macd.length*100).toFixed(0)}%`, `Tomorrow: ${gainers.length > losers.length ? "Bullish bias" : "Cautious"}`],
      faqs: [{ question: `How was NEPSE today (${today})?`, answer: `${breadth} — ${gainers.length} up, ${losers.length} down. ${g[0]?.symbol} led gains (+${Number(g[0]?.percentagechange).toFixed(2)}%). ${macdAboveZero.length}/${macd.length} MACD positive.` }, { question: "What about tomorrow?", answer: `${gainers.length > losers.length ? "Bullish bias — positive breadth and MACD support continuation" : "Cautious — watch support levels before adding positions"}.` }],
      entity_tags: ["NEPSE", "full analysis", "tomorrow outlook", g[0]?.symbol, l[0]?.symbol, t[0]?.symbol, rsi[0]?.symbol, topGS[0]]
    },
  ];

  // Strip emojis from all string fields in every blog (content, title, quick_answer, etc.)
  // so nothing emoji-flavored ever lands in the posted blog.
  const cleanedBlogs = blogs.map(stripEmojisDeep);

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(cleanedBlogs, null, 2), "utf-8");
  console.log(`\n✅ ${cleanedBlogs.length} blogs written to blogs-to-post.json (emoji-free)`);
  console.log("📝 Review the file, then run: node batch-post-blogs.js");
}

/* ─────────────── Emoji stripping ───────────────
   Removes emoji/pictograph characters from every string in an object tree.
   Covers:
     U+1F300–U+1FAFF  emoticons, pictographs, symbols & pictographs extended
     U+2600–U+27BF    misc symbols & dingbats (✅ ❌ ⚠ ➡ etc.)
     U+2190–U+21FF    arrows
     U+2300–U+23FF    misc technical
     U+25A0–U+25FF    geometric shapes
     U+2B00–U+2BFF    misc symbols & arrows
     U+FE0F           variation selector-16 (emoji presentation)
     U+200D           zero-width joiner (compound emojis)
*/
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;

function stripEmojisFromString(s) {
  if (typeof s !== "string") return s;
  return s
    .replace(EMOJI_RE, "")
    // clean up spacing artifacts left by removed emojis
    .replace(/\s+([.,!?;:])/g, "$1")   // stray space before punctuation
    .replace(/[ \t]{2,}/g, " ")        // collapse multiple spaces (keep newlines)
    .replace(/(<[a-z][^>]*>)\s+/gi, "$1") // trim leading space right after an opening tag
    .replace(/\s+(<\/[a-z]+>)/gi, "$1")   // trim trailing space right before a closing tag
    .replace(/>\s+</g, "><")           // remove whitespace between tags
    .trim();
}

function stripEmojisDeep(value) {
  if (value == null) return value;
  if (typeof value === "string") return stripEmojisFromString(value);
  if (Array.isArray(value)) return value.map(stripEmojisDeep);
  if (typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = stripEmojisDeep(value[k]);
    return out;
  }
  return value;
}

main().catch(e => { console.error("Error:", e.message); process.exit(1); });
