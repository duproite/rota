// Rota CP Fix — app do vendedor
// Lê clientes, lançamentos e preços das planilhas (via Apps Script), guarda tudo no celular
// e envia os lançamentos novos quando houver sinal.

const API = (window.ROTA_CONFIG || {}).API_URL || '';
const KEY = { dados: 'rota.dados.v1', locais: 'rota.lancamentos.v1', chave: 'rota.chave.v1' };

const $ = s => document.querySelector(s);
const brl = n => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtD = iso => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
const todayISO = () => { const t = new Date(); t.setMinutes(t.getMinutes() - t.getTimezoneOffset()); return t.toISOString().slice(0, 10); };
const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
function parseMoney(s) {
  s = (s || '').replace(/[R$\s%]/g, '');
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s); return isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}
const load = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? def; } catch (e) { return def; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

// ---------- chave (vem no link de instalação: ...#k=CHAVE) ----------
(function () {
  const m = location.hash.match(/k=([A-Za-z0-9]+)/);
  if (m) { try { localStorage.setItem(KEY.chave, m[1]); } catch (e) {} history.replaceState(null, '', location.pathname); }
})();
let chave = (() => { try { return localStorage.getItem(KEY.chave) || ''; } catch (e) { return ''; } })();

// ---------- estado ----------
let DADOS = load(KEY.dados, null);          // {geradoEm, baixadoEm, clientes, lanc, precos}
let locais = load(KEY.locais, []);          // lançamentos feitos neste celular
let clientes = [], byName = {}, saldos = {};
let ocupado = false, ultimoErro = '';

function indexar() {
  if (!DADOS) return;
  clientes = DADOS.clientes.map(([n, cod, cid, rota]) => ({ n, cod, cid, rota, key: norm(n + ' ' + cid) }));
  byName = Object.fromEntries(clientes.map(c => [c.n, c]));
  saldos = {};
  for (const l of DADOS.lanc) saldos[l[1]] = (saldos[l[1]] || 0) + l[2] - l[3];
}
const persistLocais = () => save(KEY.locais, locais);
function saldo(nome) {
  let s = saldos[nome] || 0;
  for (const l of locais) if (l.n === nome && l.status !== 'recusado') s += l.cp - l.pg;
  return Math.round(s * 100) / 100;
}
function movimentos(nome) {
  const a = DADOS.lanc.filter(l => l[1] === nome).map(l => ({ d: l[0], cp: l[2], pg: l[3], o: l[4], doc: l[5], v: l[6], local: false }));
  const b = locais.filter(l => l.n === nome && l.status !== 'recusado').map(l => ({ d: l.d, cp: l.cp, pg: l.pg, o: l.o, doc: '', v: '', local: true, status: l.status }));
  return a.concat(b).sort((x, y) => x.d < y.d ? -1 : x.d > y.d ? 1 : (x.local - y.local));
}

// ---------- sincronização ----------
async function baixar() {
  const r = await fetch(`${API}?acao=dados&chave=${encodeURIComponent(chave)}`, { cache: 'no-store' });
  const j = await r.json();
  if (!j.ok) throw new Error(j.erro === 'chave' ? 'chave' : (j.erro || 'erro'));
  return j.dados;
}
async function enviar() {
  const pend = locais.filter(l => l.status === 'pendente');
  if (!pend.length) return 0;
  const r = await fetch(API, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ chave, lancamentos: pend.map(({ id, n, d, cp, pg, o }) => ({ id, n, d, cp, pg, o })) })
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.erro || 'erro');
  const agora = Date.now();
  const ok = new Set(j.recebidos || []);
  const rec = Object.fromEntries((j.rejeitados || []).map(x => [x.id, x.motivo]));
  for (const l of locais) {
    if (ok.has(l.id)) { l.status = 'enviado'; l.enviadoEm = agora; }
    else if (rec[l.id]) { l.status = 'recusado'; l.motivo = rec[l.id]; }
  }
  persistLocais();
  return ok.size;
}
async function sincronizar(manual) {
  if (ocupado || !API || !chave) return;
  if (!navigator.onLine) { renderStatus(); if (manual) toast('Sem sinal. Os lançamentos ficam guardados no celular.'); return; }
  ocupado = true; renderStatus();
  try {
    const enviados = await enviar();
    const inicio = Date.now();
    const d = await baixar();
    d.baixadoEm = Date.now();
    DADOS = d; save(KEY.dados, DADOS);
    // o que já foi enviado agora vem da planilha: tira a cópia local
    locais = locais.filter(l => !(l.status === 'enviado' && l.enviadoEm <= inicio));
    persistLocais();
    ultimoErro = '';
    indexar();
    if (enviados) toast(`${enviados} lançamento${enviados === 1 ? '' : 's'} enviado${enviados === 1 ? '' : 's'} para a planilha.`);
    else if (manual) toast('Dados atualizados.');
  } catch (e) {
    ultimoErro = e.message === 'chave' ? 'chave' : 'rede';
    if (manual) toast(ultimoErro === 'chave' ? 'Chave inválida. Peça o link de instalação de novo ao Du.' : 'Não consegui falar com a planilha. Tento de novo sozinho.');
  } finally {
    ocupado = false;
    renderTudo();
  }
}

// ---------- status ----------
function renderStatus() {
  const on = navigator.onLine;
  $('#net').classList.toggle('off', !on);
  $('#netTxt').textContent = ocupado ? 'Atualizando…' : on ? 'Online' : 'Sem sinal';
  const pend = locais.filter(l => l.status === 'pendente').length;
  const rec = locais.filter(l => l.status === 'recusado').length;
  $('#badge').hidden = !(pend + rec); $('#badge').textContent = pend + rec;
  const s = $('#sync');
  s.classList.toggle('erro', !!ultimoErro || rec > 0);
  s.innerHTML = !DADOS ? 'Carregando…'
    : rec ? `<b>${rec} lançamento${rec === 1 ? '' : 's'} recusado${rec === 1 ? '' : 's'}.</b> Veja na aba Envio.`
    : ultimoErro === 'chave' ? '<b>Chave inválida.</b> Peça o link de instalação de novo ao Du.'
    : `Planilha de <b>${esc(DADOS.geradoEm)}</b>${pend ? ` · ${pend} aguardando envio` : ''}`;
}

// ---------- abas ----------
let tab = 'lancar';
function go(t) {
  tab = t;
  document.querySelectorAll('nav.tabs button').forEach(b => { if (b.dataset.tab === t) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  for (const v of ['setup', 'lancar', 'clientes', 'precos', 'envio']) $('#v-' + v).hidden = v !== t;
  if (t === 'clientes') renderLista();
  if (t === 'precos') renderPrecos();
  if (t === 'envio') renderEnvio();
  scrollTo(0, 0);
}
document.querySelectorAll('nav.tabs button').forEach(b => b.onclick = () => { if (!DADOS) return; if (b.dataset.tab === 'clientes') closeDetail(); go(b.dataset.tab); });
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2800); }

function renderSetup() {
  const semConfig = !API || !chave;
  $('#setupTit').textContent = semConfig ? 'Falta configurar' : 'Precisa de internet';
  $('#setupTxt').textContent = semConfig
    ? 'Cole abaixo o link de instalação que o Du mandou (ou só a chave). É só na primeira vez.'
    : (ultimoErro === 'chave' ? 'A chave de acesso não foi aceita. Peça o link de instalação de novo ao Du.'
      : 'Na primeira vez o app precisa de sinal para baixar os clientes e os preços. Depois funciona sem internet.');
  $('#setupRetry').hidden = semConfig;
  $('#setupKey').hidden = !semConfig && ultimoErro !== 'chave';
  $('#keySave').hidden = $('#setupKey').hidden;
}
$('#keySave').onclick = () => {
  const v = $('#keyIn').value.trim();
  const m = v.match(/k=([A-Za-z0-9]+)/) || v.match(/^([A-Za-z0-9]{12,})$/);
  if (!m) { $('#keyErr').textContent = 'Não reconheci. Cole o link inteiro que o Du mandou.'; return; }
  chave = m[1];
  try { localStorage.setItem(KEY.chave, chave); } catch (e) {}
  $('#keyErr').textContent = ''; ultimoErro = '';
  renderSetup(); sincronizar(true);
};
$('#setupRetry').onclick = () => sincronizar(true);

// ---------- LANÇAR ----------
let sel = null, op = 'compra', hi = -1;
$('#dOp').value = todayISO();
function filtra(q, lim) {
  const k = norm(q).trim(); if (!k) return [];
  const parts = k.split(/\s+/);
  const r = clientes.filter(c => parts.every(p => c.key.includes(p)));
  r.sort((a, b) => (norm(a.n).startsWith(k) ? 0 : 1) - (norm(b.n).startsWith(k) ? 0 : 1) || a.n.localeCompare(b.n));
  return lim ? r.slice(0, lim) : r;
}
function renderSugg() {
  const q = $('#cliQ').value; const box = $('#sugg');
  if (!q.trim()) { box.hidden = true; return; }
  const r = filtra(q, 8);
  box.innerHTML = r.length ? r.map((c, i) => `<button type="button" data-n="${esc(c.n)}" class="${i === hi ? 'hi' : ''}"><span class="nm">${esc(c.n)}</span><span class="ct">${esc(c.cid || '—')}</span></button>`).join('')
    : `<div class="empty">Nenhum cliente com esse nome. Cliente novo precisa ser cadastrado no CHECK e na planilha primeiro.</div>`;
  box.hidden = false;
  box.querySelectorAll('button').forEach(b => b.onmousedown = e => { e.preventDefault(); pick(b.dataset.n); });
}
$('#cliQ').addEventListener('input', () => { hi = -1; renderSugg(); });
$('#cliQ').addEventListener('focus', renderSugg);
$('#cliQ').addEventListener('blur', () => setTimeout(() => $('#sugg').hidden = true, 120));
$('#cliQ').addEventListener('keydown', e => {
  const r = filtra($('#cliQ').value, 8);
  if (e.key === 'ArrowDown') { hi = Math.min(hi + 1, r.length - 1); renderSugg(); e.preventDefault(); }
  if (e.key === 'ArrowUp') { hi = Math.max(hi - 1, 0); renderSugg(); e.preventDefault(); }
  if (e.key === 'Enter' && r.length) { pick(r[Math.max(hi, 0)].n); e.preventDefault(); }
});
function pick(nome) {
  sel = byName[nome]; if (!sel) return unpick();
  $('#pickerWrap').hidden = true; $('#chosen').hidden = false; $('#chosenLinks').hidden = false;
  $('#chNm').textContent = sel.n;
  $('#chCt').textContent = [sel.cid, sel.rota && ('rota ' + sel.rota)].filter(Boolean).join(' · ') || 'Sem cidade cadastrada';
  const s = saldo(sel.n); $('#chSd').textContent = brl(s); $('#chSd').style.color = s > 0 ? 'var(--compra)' : 'var(--muted)';
  $('#err').textContent = '';
}
function unpick() { sel = null; $('#pickerWrap').hidden = false; $('#chosen').hidden = true; $('#chosenLinks').hidden = true; $('#cliQ').value = ''; }
$('#chChange').onclick = () => { unpick(); $('#cliQ').focus(); };
$('#chSee').onclick = () => { const n = sel.n; go('clientes'); openDetail(n); };

document.querySelectorAll('.seg button').forEach(b => b.onclick = () => {
  op = b.dataset.op;
  document.querySelectorAll('.seg button').forEach(x => x.setAttribute('aria-pressed', x === b));
  $('#fCompra').hidden = op !== 'compra';
  $('#fPag').hidden = op !== 'pagamento';
  $('#err').textContent = '';
});

$('#save').onclick = () => {
  const err = $('#err');
  if (!sel) { err.textContent = 'Escolha o cliente antes de salvar.'; return; }
  const cp = op === 'compra' ? parseMoney($('#vCompra').value) : 0;
  const pg = op === 'pagamento' ? parseMoney($('#vPag').value) : 0;
  if (op === 'compra' && !(cp > 0)) { err.textContent = 'Digite o valor da compra (ex.: 1.250,00).'; $('#vCompra').focus(); return; }
  if (op === 'pagamento' && !(pg > 0)) { err.textContent = 'Digite o valor pago (ex.: 500,00).'; $('#vPag').focus(); return; }
  const d = $('#dOp').value; if (!d) { err.textContent = 'Informe a data.'; return; }
  locais.push({ id: uid(), n: sel.n, d, cp, pg, o: $('#obs').value.trim(), criado: new Date().toISOString(), status: 'pendente' });
  persistLocais();
  const nome = sel.n;
  $('#vCompra').value = ''; $('#vPag').value = ''; $('#obs').value = ''; $('#dOp').value = todayISO();
  pick(nome); renderStatus();
  toast(navigator.onLine ? 'Salvo. Enviando para a planilha…' : 'Salvo no celular. Envia quando tiver sinal.');
  sincronizar(false);
};

// ---------- CLIENTES ----------
let rotaSel = 'Todas', soDevendo = true;
function renderChips() {
  const rotas = [...new Set(clientes.map(c => c.rota).filter(Boolean))].sort();
  $('#rotaChips').innerHTML = ['Devendo', 'Todas', ...rotas].map(r => {
    const on = r === 'Devendo' ? soDevendo : r === 'Todas' ? rotaSel === 'Todas' : rotaSel === r;
    return `<button class="chip" type="button" data-r="${esc(r)}" aria-pressed="${on}">${r === 'Devendo' ? 'Só quem deve' : r === 'Todas' ? 'Todas as rotas' : esc(r.charAt(0) + r.slice(1).toLowerCase())}</button>`;
  }).join('');
  $('#rotaChips').querySelectorAll('.chip').forEach(b => b.onclick = () => {
    const r = b.dataset.r;
    if (r === 'Devendo') soDevendo = !soDevendo; else rotaSel = r;
    renderChips(); renderLista();
  });
}
function renderLista() {
  const q = $('#cliSearch').value;
  let r = q.trim() ? filtra(q) : clientes.slice();
  if (rotaSel !== 'Todas') r = r.filter(c => c.rota === rotaSel);
  const rows = r.map(c => ({ c, s: saldo(c.n), p: locais.some(l => l.n === c.n && l.status === 'pendente') }));
  const vis = soDevendo ? rows.filter(x => x.s > 0.004) : rows;
  vis.sort((a, b) => soDevendo ? b.s - a.s : a.c.n.localeCompare(b.c.n));
  const tot = vis.reduce((t, x) => t + Math.max(x.s, 0), 0);
  $('#sumTxt').textContent = `${vis.length} cliente${vis.length === 1 ? '' : 's'}${soDevendo ? ' devendo' : ''}`;
  $('#sumVal').textContent = brl(tot);
  $('#list').innerHTML = vis.length ? vis.map(x => `<button class="item" type="button" data-n="${esc(x.c.n)}">
     <div class="who"><div class="nm">${esc(x.c.n)}${x.p ? '<span class="pendtag">não enviado</span>' : ''}</div><div class="ct">${esc([x.c.cid, x.c.rota && x.c.rota !== x.c.cid ? 'rota ' + x.c.rota : ''].filter(Boolean).join(' · ') || '—')}</div></div>
     <div class="v num ${x.s > 0.004 ? '' : 'zero'}">${brl(x.s)}</div></button>`).join('')
    : `<div class="emptybox">Nenhum cliente encontrado com esse filtro.</div>`;
  $('#list').querySelectorAll('.item').forEach(b => b.onclick = () => openDetail(b.dataset.n));
}
$('#cliSearch').addEventListener('input', renderLista);

let detalheAberto = null;
function openDetail(nome) {
  const c = byName[nome]; if (!c) return closeDetail();
  detalheAberto = nome;
  const mv = movimentos(nome);
  let run = 0; const withRun = mv.map(m => { run += m.cp - m.pg; return { ...m, run: Math.round(run * 100) / 100 }; }).reverse();
  const tc = mv.reduce((t, m) => t + m.cp, 0), tp = mv.reduce((t, m) => t + m.pg, 0), s = tc - tp;
  const hoje = todayISO();
  const det = $('#cliDetail');
  det.innerHTML = `
   <button class="back" type="button" id="back">‹ Clientes</button>
   <div class="hero">
     <div class="nm">${esc(c.n)}</div>
     <div class="ct">${esc([c.cid, c.rota && ('rota ' + c.rota), c.cod && ('cód. CHECK ' + c.cod)].filter(Boolean).join(' · '))}</div>
     <div class="big"><span class="v num" style="color:${s > 0.004 ? 'var(--compra)' : 'var(--pago)'}">${brl(s)}</span><span class="k">${s > 0.004 ? 'em aberto' : 'nada em aberto'}</span></div>
     <div class="tot"><div class="c"><div class="k">Compras</div><div class="v num">${brl(tc)}</div></div><div class="p"><div class="k">Pagamentos</div><div class="v num">${brl(tp)}</div></div></div>
   </div>
   <div class="actions">
     <button class="btn" type="button" id="dLanc">Lançar</button>
     <button class="btn ghost" type="button" id="dCopy">Copiar resumo</button>
   </div>
   <div class="label" style="margin:4px 0 -8px">Extrato · mais recente primeiro</div>
   <div class="ext">${withRun.length ? withRun.map(m => {
      const isC = m.cp > 0; const venc = isC && !m.local && m.v && m.v < hoje;
      const meta = [m.doc && ('doc ' + esc(m.doc)), isC && m.v && `<span class="${venc ? 'due' : ''}">venc. ${fmtD(m.v)}</span>`, m.o && esc(m.o), m.local && (m.status === 'pendente' ? '<b>não enviado</b>' : 'enviado')].filter(Boolean).join(' · ');
      return `<div class="ln ${m.local ? 'local' : ''} ${venc ? 'venc' : ''}">
        <span class="tp ${isC ? 'c' : 'p'}">${isC ? 'Compra' : 'Pago'}</span>
        <span class="d num">${fmtD(m.d)}</span>
        <span class="amt num ${isC ? 'c' : 'p'}">${isC ? '+ ' : '− '}${brl(isC ? m.cp : m.pg)}</span>
        <span class="meta">${meta}</span>
        <span class="run num">saldo ${brl(m.run)}</span></div>`; }).join('') : '<div class="emptybox">Sem compras nem pagamentos registrados.</div>'}
   </div>
   <div class="copybox" id="copyFb"></div>`;
  $('#cliList').hidden = true; det.hidden = false;
  $('#back').onclick = closeDetail;
  $('#dLanc').onclick = () => { go('lancar'); pick(nome); };
  $('#dCopy').onclick = () => {
    const ult = mv.filter(m => m.cp > 0).slice(-6).map(m => `${fmtD(m.d)}  compra ${brl(m.cp)}${m.v ? ' (venc. ' + fmtD(m.v) + ')' : ''}`);
    const txt = `${c.n}\nSaldo em aberto: ${brl(s)}\nÚltimas compras:\n${ult.join('\n')}`;
    Promise.resolve().then(() => navigator.clipboard.writeText(txt)).then(() => toast('Resumo copiado. É só colar no WhatsApp.'))
      .catch(() => { const fb = $('#copyFb'); fb.innerHTML = `<textarea class="input" rows="6" readonly>${esc(txt)}</textarea>`; fb.querySelector('textarea').select(); });
  };
}
function closeDetail() { detalheAberto = null; $('#cliDetail').hidden = true; $('#cliList').hidden = false; renderLista(); }

// ---------- PREÇOS ----------
// [fornecedor, produto, custo, margem%] — preço = custo × (1 + margem/100), igual à planilha.
// Margem digitada vale só na hora; ao reabrir volta a da planilha.
let margens = {};
const pct = n => (n == null || !isFinite(n)) ? '' : n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
function renderPrecos() {
  const P = DADOS.precos;
  const k = norm($('#prodSearch').value).trim().split(/\s+/).filter(Boolean);
  const r = P.map((p, i) => [p, i]).filter(([p]) => k.every(w => norm(p[1] + ' ' + p[0]).includes(w)));
  $('#prodSum').textContent = `${r.length} produto${r.length === 1 ? '' : 's'}`;
  $('#prodList').innerHTML = r.length ? r.map(([p, id]) => {
    const mg = p[1] in margens ? margens[p[1]] : p[3];
    const head = `<div class="nm">${esc(p[1])}</div><div class="fo">${esc(p[0] || '')}</div>`;
    if (p[2] == null) return `<div class="prod">${head}<div class="semcusto">Sem custo cadastrado na tabela.</div></div>`;
    const pv = mg == null ? null : Math.round(p[2] * (1 + mg / 100) * 100) / 100;
    return `<div class="prod">${head}<div class="calc">
      <div><div class="k">Custo</div><div class="v num">${brl(p[2])}</div></div>
      <div><label class="k" for="mg${id}">Margem</label><div class="mg"><input id="mg${id}" data-i="${id}" class="num" inputmode="decimal" value="${pct(mg)}" placeholder="0"><span>%</span></div></div>
      <div class="pv"><div class="k">Preço</div><div class="v num" id="pv${id}">${pv == null ? '—' : brl(pv)}</div></div>
    </div></div>`; }).join('') : `<div class="emptybox">Nenhum produto com esse nome.</div>`;
  $('#prodList').querySelectorAll('input[data-i]').forEach(inp => inp.oninput = () => {
    const p = P[+inp.dataset.i]; const v = parseMoney(inp.value);
    const ok = inp.value.trim() !== '' && isFinite(v);
    if (ok) margens[p[1]] = v; else delete margens[p[1]];
    $('#pv' + inp.dataset.i).textContent = ok ? brl(Math.round(p[2] * (1 + v / 100) * 100) / 100) : '—';
  });
}
$('#prodSearch').addEventListener('input', renderPrecos);

// ---------- ENVIO ----------
let pendConfirm = null;
function renderEnvio() {
  const pend = locais.filter(l => l.status === 'pendente'), rec = locais.filter(l => l.status === 'recusado');
  const on = navigator.onLine;
  $('#sendStatus').innerHTML = pend.length
    ? `<div class="big num">${pend.length} aguardando</div><p>${on ? 'Com sinal: o envio é automático, mas dá pra forçar abaixo.' : 'Sem sinal: os lançamentos estão guardados no celular e vão sozinhos quando a internet voltar.'}</p>`
    : `<div class="big">Tudo enviado</div><p>Nenhum lançamento esperando no celular. Planilha de ${esc(DADOS.geradoEm)}.</p>`;
  $('#sendBtn').disabled = ocupado || !on;
  $('#sendBtn').textContent = ocupado ? 'Enviando…' : !on ? 'Sem sinal' : pend.length ? 'Enviar agora' : 'Atualizar dados';
  const card = (l, modo) => `<div class="ln pl ${modo !== 'ok' ? 'local' : ''}">
      <span class="tp ${l.cp > 0 ? 'c' : 'p'}">${l.cp > 0 ? 'Compra' : 'Pago'}</span>
      <span class="d">${esc(l.n)}</span>
      <span class="amt num ${l.cp > 0 ? 'c' : 'p'}">${brl(l.cp || l.pg)}</span>
      <span class="meta">${fmtD(l.d)}${l.o ? ' · ' + esc(l.o) : ''}</span>
      <span class="run">${pendConfirm === l.id ? `<span class="confirm">Apagar? <button class="yes" data-y="${l.id}">Sim</button><button data-no="1">Não</button></span>` : `<button class="rm" data-rm="${l.id}">Apagar</button>`}</span>
      ${modo === 'rec' ? `<span class="why">Recusado pela planilha: ${esc(l.motivo)}</span>` : ''}</div>`;
  $('#pendList').innerHTML =
    (rec.length ? `<div class="label" style="margin-bottom:-8px">Recusados · confira e lance de novo</div><div class="ext">${rec.map(l => card(l, 'rec')).join('')}</div>` : '') +
    (pend.length ? `<div class="label" style="margin-bottom:-8px">Aguardando envio</div><div class="ext">${pend.map(l => card(l, 'pend')).join('')}</div>` : '');
  $('#pendList').querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { pendConfirm = b.dataset.rm; renderEnvio(); });
  $('#pendList').querySelectorAll('[data-no]').forEach(b => b.onclick = () => { pendConfirm = null; renderEnvio(); });
  $('#pendList').querySelectorAll('[data-y]').forEach(b => b.onclick = () => { locais = locais.filter(l => l.id !== b.dataset.y); pendConfirm = null; persistLocais(); renderStatus(); renderEnvio(); toast('Lançamento apagado.'); });
}
$('#sendBtn').onclick = () => sincronizar(true);

// ---------- montagem ----------
function renderTudo() {
  renderStatus();
  if (!DADOS) { renderSetup(); go('setup'); return; }
  if (tab === 'setup') go('lancar');
  renderChips();
  if (sel) pick(sel.n);
  if (tab === 'clientes') { if (detalheAberto) openDetail(detalheAberto); else renderLista(); }
  if (tab === 'precos') renderPrecos();
  if (tab === 'envio') renderEnvio();
}
addEventListener('online', () => sincronizar(false));
addEventListener('offline', renderStatus);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sincronizar(false); });
setInterval(() => { if (document.visibilityState === 'visible' && locais.some(l => l.status === 'pendente')) sincronizar(false); }, 60000);

indexar();
renderTudo();
sincronizar(false);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
