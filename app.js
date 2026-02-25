    import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
    import { getAuth, signInWithCustomToken, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
    import { getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

    const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
    const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
    const initToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

    let app, auth, db;
    try {
        if (Object.keys(firebaseConfig).length > 0) {
            app = initializeApp(firebaseConfig);
            auth = getAuth(app);
            db = getFirestore(app);
        } else {
            console.warn("Firebase config is missing or empty.");
        }
    } catch (e) {
        console.error("Firebase initialization failed:", e);
    }

    const { createApp, ref, reactive, onMounted, computed } = window.Vue;
    const gerarId = () => Date.now().toString(36) + Math.random().toString(36).substring(2);

    createApp({
      setup() {
        const tabAtual = ref('estudar');
        const grupoSelecionadoId = ref(null);
        const grupos = ref([]);
        const cartoes = ref([]);
        const isLoading = ref(true);
        const isSaving = ref(false);
        const isFetchingDef = ref(false);
        const isImporting = ref(false);
        const importMsg = ref('');
        const currentUser = ref(null);
        const mostrandoResposta = ref(false);
        const novoGrupoNome = ref('');
        const ultimaPalavraBuscada = ref('');
        const novoCartao = reactive({ groupId: '', front: '', back: '', sentences: [''] });

        // --- RESUMOS ---
        const gruposResumo = computed(() => {
          const hoje = new Date().toISOString();
          return grupos.value.map(g => {
            const cards = cartoes.value.filter(c => c.groupId === g.id);
            const due = cards.filter(c => c.srsData.nextReviewDate <= hoje);
            return { ...g, totalCards: cards.length, dueCount: due.length };
          });
        });

        const totalParaRevisar = computed(() => {
          const hoje = new Date().toISOString();
          return cartoes.value.filter(c => c.srsData.nextReviewDate <= hoje).length;
        });

        const cartoesParaRevisar = computed(() => {
          const hoje = new Date().toISOString();
          let filtrados = cartoes.value.filter(c => c.srsData.nextReviewDate <= hoje);
          if (grupoSelecionadoId.value) filtrados = filtrados.filter(c => c.groupId === grupoSelecionadoId.value);
          return filtrados;
        });

        const cartaoAtual = computed(() => cartoesParaRevisar.value[0] || null);

        // --- EXPORTAÇÃO (NOVA FUNCIONALIDADE) ---
        const exportarFicheiro = (formato, grupoId = null) => {
          let listaCartoes = grupoId ? cartoes.value.filter(c => c.groupId === grupoId) : cartoes.value;
          let nomeGrupo = grupoId ? grupos.value.find(g => g.id === grupoId)?.name || 'Grupo' : 'Todos';
          let dataStr = new Date().toISOString().split('T')[0];
          let fileName = `MeuAnki_${nomeGrupo}_${dataStr}`;

          if (formato === 'json') {
            const output = {
                versao: "1.0",
                grupo: nomeGrupo,
                data: dataStr,
                grupos: grupoId ? [grupos.value.find(g => g.id === grupoId)] : grupos.value,
                cartoes: listaCartoes
            };
            downloadBlob(JSON.stringify(output, null, 2), `${fileName}.json`, 'application/json');
          } else {
            // Formato CSV (front, back, hint, publishedAt)
            let csvContent = "front,back,hint,publishedAt\n";
            listaCartoes.forEach(c => {
                let front = escapeCSV(c.front);
                let back = escapeCSV(c.back);
                let hint = escapeCSV(c.contextSentences[0] || "");
                let date = c.srsData.nextReviewDate || new Date().toISOString();
                csvContent += `"${front}","${back}","${hint}","${date}"\n`;
            });
            downloadBlob(csvContent, `${fileName}.csv`, 'text/csv');
          }
        };

        const escapeCSV = (text) => text.replace(/"/g, '""');

        const downloadBlob = (content, fileName, mimeType) => {
          const blob = new Blob([content], { type: mimeType });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = fileName;
          document.body.appendChild(a); a.click();
          document.body.removeChild(a); URL.revokeObjectURL(url);
        };

        // --- IMPORTAÇÃO DUOCARDS ---
        const importarDuoCards = async (event) => {
          const file = event.target.files[0];
          if (!file || !currentUser.value || !db) return;
          isImporting.value = true;
          importMsg.value = "Lendo CSV...";
          const reader = new FileReader();
          reader.onload = async (e) => {
            const rows = parseCSV(e.target.result).slice(1);
            const idGrupo = gerarId();
            try {
                await setDoc(doc(db, 'artifacts', appId, 'users', currentUser.value.uid, 'grupos', idGrupo), {
                  name: `Importado ${new Date().toLocaleDateString()}`,
                  createdAt: new Date().toISOString()
                });
                for (const row of rows) {
                  if (row.length >= 2 && row[0].trim() !== '') {
                    const card = {
                      groupId: idGrupo,
                      front: row[0].trim(),
                      back: row[1].trim(),
                      contextSentences: [row[2]?.trim() || ''],
                      srsData: { easeFactor: 2.5, interval: 0, repetitions: 0, nextReviewDate: new Date().toISOString() },
                      metadata: { source: 'duocards_import', tags: [] }
                    };
                    await setDoc(doc(db, 'artifacts', appId, 'users', currentUser.value.uid, 'cartoes', gerarId()), card);
                  }
                }
                importMsg.value = `Importado!`;
            } catch (err) {
                console.error("Import error:", err);
                importMsg.value = "Erro ao importar.";
            }
            isImporting.value = false;
          };
          reader.readAsText(file);
        };

        function parseCSV(text) {
          const lines = text.split(/\r?\n/);
          return lines.map(line => {
            const result = []; let cell = ''; let inQuotes = false;
            for (let i = 0; i < line.length; i++) {
              const char = line[i];
              if (char === '"') inQuotes = !inQuotes;
              else if (char === ',' && !inQuotes) { result.push(cell); cell = ''; }
              else cell += char;
            }
            result.push(cell);
            return result;
          }).filter(line => line.some(cell => cell.trim() !== ''));
        }

        // --- TRADUÇÃO & CLOUD ---
        const buscarDadosDaPalavra = async () => {
          const p = novoCartao.front.trim();
          if (!p || p.toLowerCase() === ultimaPalavraBuscada.value.toLowerCase()) return;
          isFetchingDef.value = true;
          ultimaPalavraBuscada.value = p;
          try {
            const [resT, resF] = await Promise.allSettled([
              fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(p)}&langpair=en|pt-br`).then(r => r.json()),
              fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(p)}`).then(r => r.ok ? r.json() : null)
            ]);
            if (resT.status === 'fulfilled') novoCartao.back = resT.value.responseData.translatedText;
            if (resF.status === 'fulfilled' && resF.value) {
              let ex = [];
              resF.value[0].meanings.forEach(m => m.definitions.forEach(d => { if(d.example && ex.length < 1) ex.push(d.example); }));
              novoCartao.sentences[0] = ex[0] || '';
            }
          } finally { isFetchingDef.value = false; }
        };

        const carregarDados = (uid) => {
          if (!db) return;
          onSnapshot(collection(db, 'artifacts', appId, 'users', uid, 'grupos'), (snap) => {
            grupos.value = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            if (grupos.value.length === 0) {
              const id = gerarId();
              setDoc(doc(db, 'artifacts', appId, 'users', uid, 'grupos', id), { name: 'Geral', createdAt: new Date().toISOString() });
            } else if (!novoCartao.groupId) novoCartao.groupId = grupos.value[0].id;
          });
          onSnapshot(collection(db, 'artifacts', appId, 'users', uid, 'cartoes'), (snap) => {
            cartoes.value = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            isLoading.value = false;
          });
        };

        const calcularProximoIntervalo = (q) => {
          if(!cartaoAtual.value) return 0;
          let s = cartaoAtual.value.srsData;
          if(q < 3) return 0;
          let reps = s.repetitions + 1;
          if(reps === 1) return 1;
          if(reps === 2) return 6;
          let nv = Math.round(s.interval * s.easeFactor);
          return q === 4 ? Math.round(nv * 1.3) : nv;
        };

        const responderCartao = async (q) => {
          if (!db || !currentUser.value) return;
          isSaving.value = true;
          let c = { ...cartaoAtual.value };
          let s = { ...c.srsData };
          if(q === 1) { s.repetitions = 0; s.interval = 1; }
          else {
            s.repetitions++;
            if(s.repetitions === 1) s.interval = 1;
            else if(s.repetitions === 2) s.interval = 6;
            else { s.interval = Math.round(s.interval * s.easeFactor); if(q === 4) s.interval = Math.round(s.interval * 1.3); }
          }
          s.easeFactor = Math.max(1.3, s.easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
          const d = new Date(); if(q > 1) d.setDate(d.getDate() + s.interval); else d.setMinutes(d.getMinutes() + 10);
          s.nextReviewDate = d.toISOString(); c.srsData = s;
          await setDoc(doc(db, 'artifacts', appId, 'users', currentUser.value.uid, 'cartoes', c.id), c);
          mostrandoResposta.value = false; isSaving.value = false;
        };

        const salvarCartao = async () => {
          if (!db || !currentUser.value) { alert("Configuração de banco de dados ausente."); return; }
          isSaving.value = true;
          const c = { groupId: novoCartao.groupId, front: novoCartao.front, back: novoCartao.back, contextSentences: [...novoCartao.sentences], srsData: { easeFactor: 2.5, interval: 0, repetitions: 0, nextReviewDate: new Date().toISOString() }, metadata: { source: 'manual', tags: [] } };
          await setDoc(doc(db, 'artifacts', appId, 'users', currentUser.value.uid, 'cartoes', gerarId()), c);
          novoCartao.front = ''; novoCartao.back = ''; novoCartao.sentences = ['']; ultimaPalavraBuscada.value = '';
          isSaving.value = false;
        };

        const adicionarGrupo = async () => {
          if (!db || !currentUser.value) { alert("Configuração de banco de dados ausente."); return; }
          if(!novoGrupoNome.value) return;
          await setDoc(doc(db, 'artifacts', appId, 'users', currentUser.value.uid, 'grupos', gerarId()), { name: novoGrupoNome.value, createdAt: new Date().toISOString() });
          novoGrupoNome.value = '';
        };

        const deletarCartao = async (id) => {
            if (!db || !currentUser.value) return;
            if(confirm('Eliminar?')) await deleteDoc(doc(db, 'artifacts', appId, 'users', currentUser.value.uid, 'cartoes', id));
        };
        const mudarAba = (aba) => { tabAtual.value = aba; grupoSelecionadoId.value = null; mostrandoResposta.value = false; };
        const selecionarGrupo = (id) => { grupoSelecionadoId.value = id; mostrandoResposta.value = false; };
        const getNomeGrupo = (id) => grupos.value.find(g => g.id === id)?.name || 'Geral';

        onMounted(() => {
          if (auth) {
              const initNuvem = async () => {
                  try {
                    if (initToken) await signInWithCustomToken(auth, initToken);
                    else await signInAnonymously(auth);
                  } catch (e) {
                      console.error("Auth error:", e);
                      isLoading.value = false;
                  }
              };
              initNuvem();
              onAuthStateChanged(auth, u => { currentUser.value = u; if(u) carregarDados(u.uid); else isLoading.value = false; });
          } else {
              console.warn("Auth not initialized.");
              isLoading.value = false;
          }
        });

        return {
          tabAtual, grupoSelecionadoId, grupos, cartoes, isLoading, isSaving, isFetchingDef, isImporting,
          importMsg, mostrandoResposta, novoGrupoNome, novoCartao, totalParaRevisar, gruposResumo,
          cartoesParaRevisar, cartaoAtual, responderCartao, calcularProximoIntervalo, salvarCartao,
          adicionarGrupo, deletarCartao, mudarAba, selecionarGrupo, getNomeGrupo, importarDuoCards, buscarDadosDaPalavra, exportarFicheiro
        };
      }
    }).mount('#app');