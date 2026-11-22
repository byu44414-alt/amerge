import { Keypair, Horizon, TransactionBuilder, Operation, Asset, Networks } from '@stellar/stellar-sdk';

const HORIZON = "https://horizon.stellar.org";
const server = new Horizon.Server(HORIZON);
const NETWORK = Networks.PUBLIC;

function log(msg) {
  console.log(`[MERGE] ${msg}`);
}

function bersihSk(teks) {
  return teks.trim().replace(/\s+/g, '').replace(/[^\x20-\x7E]/g, '');
}

async function getBalances(publicKey) {
  const acc = await server.loadAccount(publicKey);
  return acc.balances;
}

// FIX UTAMA: forSeller -> seller (SDK v12)
async function getOffers(publicKey) {
  try {
    const res = await server.offers().seller(publicKey).limit(200).call();
    return res.records || [];
  } catch (e) {
    // Fallback kalo SDK ganti API lagi, langsung tembak Horizon
    log(`getOffers via SDK gagal (${e.message}), fallback ke fetch`);
    const r = await fetch(`${HORIZON}/offers?seller=${publicKey}&limit=200`, { headers: { Accept: "application/json" } });
    if (!r.ok) return [];
    const j = await r.json();
    return j._embedded?.records || [];
  }
}

async function getBestPath(sourceCode, sourceIssuer, amount) {
  const params = new URLSearchParams({
    source_amount: String(amount),
    source_asset_type: sourceCode.length > 4 ? "credit_alphanum12" : "credit_alphanum4",
    source_asset_code: sourceCode,
    source_asset_issuer: sourceIssuer,
    destination_assets: "native",
  });
  const r = await fetch(`${HORIZON}/paths/strict-send?${params}`, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`Path error: ${await r.text()}`);
  const j = await r.json();
  const records = j._embedded?.records || [];
  if (!records.length) return null;
  return records.sort((a, b) => parseFloat(b.destination_amount) - parseFloat(a.destination_amount))[0];
}

function ambilPesanError(e) {
  // Biar error Horizon keliatan jelas di Telegram, bukan cuma [object]
  try {
    const extras = e?.response?.data?.extras;
    if (extras?.result_codes) return `${e.message} | ${JSON.stringify(extras.result_codes)}`;
    if (extras) return `${e.message} | ${JSON.stringify(extras).slice(0, 300)}`;
    if (e?.response?.data) return JSON.stringify(e.response.data).slice(0, 300);
  } catch {}
  return e.message || String(e);
}

async function submitTx(kp, operations) {
  const account = await server.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: "10000",
    networkPassphrase: NETWORK,
  })
    .addOperations(operations)
    .setTimeout(60)
    .build();
  tx.sign(kp);
  try {
    return await server.submitTransaction(tx);
  } catch (e) {
    console.log("HORIZON ERROR:", e.response?.data?.extras || e.message);
    throw new Error(ambilPesanError(e));
  }
}

async function cancelAllOffers(kp) {
  const offers = await getOffers(kp.publicKey());
  if (!offers.length) { log("Tidak ada offers, skip cancel"); return; }
  log(`Cancel ${offers.length} offers...`);
  for (const offer of offers) {
    const selling = offer.selling.asset_type === "native" ? Asset.native() : new Asset(offer.selling.asset_code, offer.selling.asset_issuer);
    const buying = offer.buying.asset_type === "native" ? Asset.native() : new Asset(offer.buying.asset_code, offer.buying.asset_issuer);
    await submitTx(kp, [Operation.manageSellOffer({
      selling, buying, amount: "0", price: "1", offerId: offer.id,
    })]);
    log(`  Offer ${offer.id} cancelled`);
  }
}

async function swapAllToXlm(kp, slippagePct = 2.0) {
  const balances = await getBalances(kp.publicKey());
  let total = 0;
  for (const bal of balances) {
    if (bal.asset_type === "native") continue;
    const code = bal.asset_code;
    const issuer = bal.asset_issuer;
    const amount = parseFloat(bal.balance);
    if (amount <= 0) continue;

    log(`Swap ${amount} ${code} -> XLM...`);
    const best = await getBestPath(code, issuer, amount);
    if (!best) {
      log(`  GAK ADA PATH ${code} -> XLM, kirim balik ke issuer ${issuer}`);
      await submitTx(kp, [Operation.payment({
        destination: issuer,
        asset: new Asset(code, issuer),
        amount: amount.toFixed(7),
      })]);
      log(`  OK ${amount} ${code} dikirim ke issuer`);
      continue;
    }

    const destAmount = parseFloat(best.destination_amount);
    const destMin = (destAmount * (1 - slippagePct / 100)).toFixed(7);
    const pathAssets = (best.path || []).map(p =>
      p.asset_type === "native" ? Asset.native() : new Asset(p.asset_code, p.asset_issuer)
    );

    await submitTx(kp, [Operation.pathPaymentStrictSend({
      sendAsset: new Asset(code, issuer),
      sendAmount: amount.toFixed(7),
      destination: kp.publicKey(),
      destAsset: Asset.native(),
      destMin,
      path: pathAssets,
    })]);
    log(`  OK ${code} -> ${destAmount} XLM (min ${destMin})`);
    total += destAmount;
  }
  return total;
}

async function removeAllTrustlines(kp) {
  const balances = await getBalances(kp.publicKey());
  for (const bal of balances) {
    if (bal.asset_type === "native") continue;
    const code = bal.asset_code;
    const issuer = bal.asset_issuer;
    const saldo = parseFloat(bal.balance);
    if (saldo > 0.0000001) throw new Error(`Saldo ${code} masih ${saldo}, belum bisa hapus trustline`);
    log(`Hapus trustline ${code}...`);
    await submitTx(kp, [Operation.changeTrust({ asset: new Asset(code, issuer), limit: "0" })]);
    log(`  OK trustline ${code} dihapus`);
  }
  log("Semua trustline terhapus");
}

async function proses1Wallet(secret, tujuan) {
  secret = bersihSk(secret);
  tujuan = bersihSk(tujuan);
  const kp = Keypair.fromSecret(secret);
  log(`=== START MERGE ${kp.publicKey()} -> ${tujuan} ===`);

  try { await server.loadAccount(tujuan); }
  catch { throw new Error(`Wallet tujuan ${tujuan} belum aktif / belum funded`); }

  await cancelAllOffers(kp);
  await swapAllToXlm(kp, 2.0);
  await removeAllTrustlines(kp);

  const balances = await getBalances(kp.publicKey());
  const nonXlm = balances.filter(b => b.asset_type !== "native");
  if (nonXlm.length) throw new Error(`Masih ada trustline tersisa: ${JSON.stringify(nonXlm)}`);

  const xlmBalance = parseFloat(balances.find(b => b.asset_type === "native").balance);
  log(`Sisa XLM: ${xlmBalance}, siap merge...`);

  const resp = await submitTx(kp, [Operation.accountMerge({ destination: tujuan })]);
  log(`=== DONE MERGED, hash: ${resp.hash} ===`);

  return { wallet: kp.publicKey(), tujuan, xlm_pindah: xlmBalance, hash: resp.hash, status: "merged" };
}

async function kirimTele(token, chatId, text) {
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

// === TELEGRAM WEBHOOK - FORMAT BISTON ===
async function handleTelegramUpdate(update, env) {
  const msg = update.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === "/start" || text === "/help") {
    await kirimTele(env.TELE_TOKEN, chatId,
`BISTON MERGE BOT -

Format:
Baris 1: wallet TUJUAN
Baris 2-11: SK wallet yang mau di-merge

Contoh:
G... tujuan
S... 1
S... 2
... sampai 10 SK

Langsung paste aja blok-nya ke sini, gak usah pake /merge.`);
    return;
  }

  const lines = text.split("\n").map(s => s.trim()).filter(Boolean);

  if (!lines[0]?.startsWith("G")) {
    await kirimTele(env.TELE_TOKEN, chatId, "Format salah.\n\nKirim gini:\nG... tujuan\nS... 1\nS... 2");
    return;
  }

  const tujuan = lines[0];
  const secrets = lines.slice(1).filter(l => l.startsWith("S"));

  if (secrets.length === 0) {
    await kirimTele(env.TELE_TOKEN, chatId, "SK gak ketemu. Baris 2 dst harus diawali S...");
    return;
  }
  if (secrets.length > 10) {
    await kirimTele(env.TELE_TOKEN, chatId, "Maksimal 10 SK sekali kirim. Lu kirim " + secrets.length);
    return;
  }

  await kirimTele(env.TELE_TOKEN, chatId, `⏳ BISTON MERGE dimulai\nTujuan: ${tujuan}\nTotal: ${secrets.length} wallet`);

  for (let i = 0; i < secrets.length; i++) {
    try {
      await kirimTele(env.TELE_TOKEN, chatId, `⏳ [${i + 1}/${secrets.length}] Proses...`);
      const hasil = await proses1Wallet(secrets[i], tujuan);
      await kirimTele(env.TELE_TOKEN, chatId, `✅ [${i + 1}/${secrets.length}] DONE ${hasil.xlm_pindah} XLM\nHash: ${hasil.hash}`);
    } catch (e) {
      await kirimTele(env.TELE_TOKEN, chatId, `❌ [${i + 1}/${secrets.length}] GAGAL: ${ambilPesanError(e)}\nSTOP. Sisa wallet gak diproses.`);
      break;
    }
  }
  await kirimTele(env.TELE_TOKEN, chatId, "Selesai.");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/telegram" && request.method === "POST") {
      const update = await request.json().catch(() => ({}));
      ctx.waitUntil(handleTelegramUpdate(update, env));
      return new Response("OK");
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ ok: false, msg: "Use POST /merge atau POST /batch" }), { headers: { "Content-Type": "application/json" } });
    }
    const body = await request.json().catch(() => ({}));
    if (url.pathname === "/merge") {
      try {
        const hasil = await proses1Wallet(body.secret, body.tujuan);
        return Response.json({ ok: true, ...hasil });
      } catch (e) {
        return Response.json({ ok: false, error: ambilPesanError(e) }, { status: 500 });
      }
    }
    if (url.pathname === "/batch") {
      const { tujuan, secrets = [] } = body;
      ctx.waitUntil((async () => {
        for (let i = 0; i < secrets.length; i++) {
          try {
            await kirimTele(env.TELE_TOKEN, env.TELE_CHAT_ID, `⏳ [${i + 1}/${secrets.length}] Proses...`);
            const hasil = await proses1Wallet(secrets[i], tujuan);
            await kirimTele(env.TELE_TOKEN, env.TELE_CHAT_ID, `✅ [${i + 1}/${secrets.length}] DONE ${hasil.xlm_pindah} XLM\nHash: ${hasil.hash}`);
          } catch (e) {
            await kirimTele(env.TELE_TOKEN, env.TELE_CHAT_ID, `❌ [${i + 1}/${secrets.length}] GAGAL: ${ambilPesanError(e)}\nSTOP.`);
            break;
          }
        }
        await kirimTele(env.TELE_TOKEN, env.TELE_CHAT_ID, "Selesai.");
      })());
      return Response.json({ ok: true, msg: `Batch ${secrets.length} wallet dimulai` });
    }
    return new Response("Not Found", { status: 404 });
  },
};
