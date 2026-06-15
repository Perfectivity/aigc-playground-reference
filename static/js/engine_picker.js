/* engine_picker.js — visual engine picker (cards + version drawer)
 *
 * Drop-in replacement UI for the existing <select> + <optgroup> pickers used
 * for LLM model, Image engine, and Video engine. We keep the original <select>
 * in the DOM as the source-of-truth value (hidden), so all existing code that
 * reads `.value` and listens to `change` keeps working unchanged.
 *
 * Public API:
 *   EnginePicker.init(selectId, options?)   — wraps the given <select>.
 *   EnginePicker.refresh(selectId)          — re-render after options changed.
 *
 * Behavior:
 *   - Renders a card grid (one card per <optgroup> = engine family).
 *   - Selecting a card opens a drawer below with the family's versions as
 *     pill buttons. Clicking a version updates the hidden select and fires
 *     a `change` event, so existing onchange handlers run as before.
 *   - First initialization auto-selects the family that contains the
 *     currently-selected option (or the family of the first non-disabled
 *     option if none).
 *   - Logos are loaded from /static/engines/<key>.png; if missing, a
 *     colored initial-letter circle is rendered as fallback.
 */
(function (global) {
  'use strict';

  // ------------------------------------------------------------------
  // Family mapping. Keys are matched against the optgroup `label` text
  // (case-insensitive substring).  When a match is found, that family's
  // visual identity (logo, color, display name) is used.
  //
  // Order matters: more specific labels first.
  // ------------------------------------------------------------------
  const FAMILIES = [
    // --- Image families that share company name with LLMs (must come FIRST) ---
    { key:'gem',      match:['gem (','gem image','google gemini image','nano','gemini image'], name:'Gemini Image', company:'Google',  color:'#4285F4', logo:'gem.png'      },
    { key:'og',       match:['og (','og image','openai image','gpt image'],                    name:'GPT Image',    company:'OpenAI',  color:'#10a37f', logo:'og.png'       },
    { key:'kling_img',match:['kling (可灵 image)','kling image','kling (image)'],               name:'Kling Image',  company:'Kuaishou',color:'#A435F0', logo:'kling.png'   },
    { key:'jimeng_img',match:['jimeng (即梦 image)','jimeng image','jimeng (image)'],           name:'Jimeng Image', company:'ByteDance',color:'#FF1493', logo:'jimeng.png'  },
    { key:'vidu_img', match:['vidu image','vidu (image)'],                                     name:'Vidu Image',   company:'Shengshu',color:'#0EA5E9', logo:'vidu.png'    },

    // --- LLM ---
    { key:'gemini',   match:['gemini'],                    name:'Gemini',     company:'Google',     color:'#4285F4', logo:'gemini.png'   },
    { key:'openai',   match:['openai'],                    name:'OpenAI',     company:'OpenAI',     color:'#10a37f', logo:'openai.png'   },
    { key:'claude',   match:['claude'],                    name:'Claude',     company:'Anthropic',  color:'#C96442', logo:'claude.png'   },
    { key:'xai',      match:['xai','grok'],                name:'Grok',       company:'xAI',        color:'#000000', logo:'xai.png'      },
    { key:'moonshot', match:['moonshot','kimi'],           name:'Kimi',       company:'Moonshot',   color:'#7B5CFF', logo:'moonshot.png' },
    { key:'zhipu',    match:['zhipu','glm'],               name:'GLM',        company:'Zhipu AI',   color:'#1E5BC6', logo:'zhipu.png'    },
    { key:'lyria',    match:['lyria'],                     name:'Lyria',      company:'Google',     color:'#5b34c8', logo:'lyria.png'    },
    { key:'minimax',  match:['minimax'],                   name:'MiniMax',    company:'MiniMax',    color:'#FF7300', logo:'minimax.png'  },
    { key:'deepseek', match:['deepseek'],                  name:'DeepSeek',   company:'DeepSeek',   color:'#4D6BFE', logo:'deepseek.png' },

    // --- Image-only extras ---
    { key:'seedream', match:['seedream'],                  name:'Seedream',   company:'ByteDance',  color:'#FF6B35', logo:'seedream.png' },
    { key:'qwen',     match:['qwen','通义万相'],            name:'Qwen',       company:'Alibaba',    color:'#615CED', logo:'qwen.png'     },
    { key:'mj',       match:['midjourney','mj '],          name:'Midjourney', company:'Midjourney', color:'#000000', logo:'mj.png'       },

    // --- Video engines ---
    { key:'kling',    match:['kling'],                     name:'Kling',      company:'Kuaishou',   color:'#A435F0', logo:'kling.png'    },
    { key:'hailuo',   match:['hailuo','海螺'],              name:'Hailuo',     company:'MiniMax',    color:'#FF7300', logo:'hailuo.png'   },
    { key:'vidu',     match:['vidu'],                      name:'Vidu',       company:'Shengshu',   color:'#0EA5E9', logo:'vidu.png'     },
    { key:'seedance', match:['seedance'],                  name:'Seedance',   company:'ByteDance',  color:'#FF6B35', logo:'seedance.png' },
    { key:'pixverse', match:['pixverse'],                  name:'PixVerse',   company:'AIsphere',   color:'#22C55E', logo:'pixverse.png' },
    { key:'jimeng',   match:['jimeng','即梦'],              name:'Jimeng',     company:'ByteDance',  color:'#FF1493', logo:'jimeng.png'   },
    { key:'veo',      match:['gv ','gv (','veo','google veo'],  name:'Veo',    company:'Google',     color:'#4285F4', logo:'veo.png'      },
    { key:'sora',     match:['os ','sora','openai sora'],  name:'Sora',       company:'OpenAI',     color:'#000000', logo:'sora.png'     },
    { key:'mingmou',  match:['mingmou','明眸'],             name:'Mingmou',    company:'Tencent',    color:'#0052D9', logo:'mingmou.svg'  },
    { key:'wan',      match:['wan','万相','阿里万相'],       name:'Wan',        company:'Alibaba',    color:'#FF6A00', logo:'wan.png'      },
    { key:'hunyuan',  match:['hunyuan','混元'],             name:'Hunyuan',    company:'Tencent',    color:'#0052D9', logo:'hunyuan.png'  },
    { key:'h2',       match:['h2','happyhorse','海马'],     name:'Happyhorse', company:'Haima',      color:'#FFA500', logo:'h2.png'       },
  ];

  function findFamily(label) {
    if (!label) return null;
    const low = String(label).toLowerCase();
    for (const f of FAMILIES) {
      for (const tok of f.match) {
        if (low.indexOf(tok) >= 0) return f;
      }
    }
    return null;
  }

  function familyFromOptionId(id) {
    // Heuristics for option ids that don't carry their group label (rare).
    const m = String(id || '').toLowerCase();
    return FAMILIES.find(f => f.match.some(t => m.startsWith(t.replace(/[ ()]/g,'')))) || null;
  }

  // ------------------------------------------------------------------
  // DOM helpers
  // ------------------------------------------------------------------
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function logoNode(family) {
    const wrap = el('div', 'ep-logo');
    if (family && family.logo) {
      const img = new Image();
      img.src = '/static/engines/' + family.logo;
      img.alt = family.name;
      img.loading = 'lazy';
      img.onerror = function () {
        wrap.innerHTML = '';
        const ini = el('div', 'ep-logo-fallback');
        ini.style.background = (family && family.color) || '#444';
        ini.textContent = ((family && family.name) || '?').slice(0,1).toUpperCase();
        wrap.appendChild(ini);
      };
      wrap.appendChild(img);
    } else {
      const ini = el('div', 'ep-logo-fallback');
      ini.style.background = '#444';
      ini.textContent = '?';
      wrap.appendChild(ini);
    }
    return wrap;
  }

  // ------------------------------------------------------------------
  // Build a model from the <select> (groups → families).
  // ------------------------------------------------------------------
  function buildModel(sel) {
    const groups = []; // [{family, label, items:[{value,text,disabled,badge}]}]
    let current = null;
    Array.from(sel.children).forEach(child => {
      if (child.tagName === 'OPTGROUP') {
        const fam = findFamily(child.label) || { key: child.label, name: child.label, company:'', color:'#555', logo:null };
        current = { family: fam, label: child.label, items: [] };
        groups.push(current);
        Array.from(child.children).forEach(opt => {
          current.items.push({
            value: opt.value,
            text:  opt.textContent.trim(),
            disabled: !!opt.disabled,
            selected: !!opt.selected,
          });
        });
      } else if (child.tagName === 'OPTION') {
        const fam = familyFromOptionId(child.value) || { key:'misc', name:'Other', color:'#555', logo:null };
        if (!current || current.family.key !== fam.key) {
          current = { family: fam, label: fam.name, items: [] };
          groups.push(current);
        }
        current.items.push({
          value: child.value,
          text:  child.textContent.trim(),
          disabled: !!child.disabled,
          selected: !!child.selected,
        });
      }
    });
    return groups;
  }

  // ------------------------------------------------------------------
  // Render one engine picker for a given <select>.
  // ------------------------------------------------------------------
  function ensureContainers(sel) {
    let host = sel.previousElementSibling;
    if (!host || !host.classList || !host.classList.contains('ep-host')) {
      host = el('div', 'ep-host');
      host.dataset.target = sel.id;
      // Insert before the select.
      sel.parentNode.insertBefore(host, sel);
      // Hide the select so original handlers still operate, but it isn't shown.
      sel.classList.add('ep-original-select');
    }
    let grid = host.querySelector('.ep-grid');
    if (!grid) { grid = el('div', 'ep-grid'); host.appendChild(grid); }
    let drawer = host.querySelector('.ep-drawer');
    if (!drawer) { drawer = el('div', 'ep-drawer'); host.appendChild(drawer); }
    return { host, grid, drawer };
  }

  function renderDrawer(drawer, group, sel) {
    drawer.innerHTML = '';
    if (!group) { drawer.classList.remove('open'); return; }
    drawer.classList.add('open');

    const head = el('div', 'ep-drawer-head');
    const title = el('div', 'ep-drawer-title');
    title.appendChild(logoNode(group.family));
    const txt = el('div', 'ep-drawer-title-text');
    txt.innerHTML = '<div class="ep-drawer-name">'+ escapeHtml(group.family.name) +'</div>'
                  + (group.family.company ? '<div class="ep-drawer-co">'+ escapeHtml(group.family.company) +'</div>' : '');
    title.appendChild(txt);
    head.appendChild(title);
    drawer.appendChild(head);

    const list = el('div', 'ep-versions');
    group.items.forEach(it => {
      const chip = el('button', 'ep-chip' + (it.disabled ? ' is-disabled' : '') + (it.value === sel.value ? ' is-active' : ''));
      chip.type = 'button';
      chip.textContent = it.text;
      if (it.disabled) chip.disabled = true;
      chip.addEventListener('click', () => {
        if (it.disabled) return;
        if (sel.value !== it.value) {
          sel.value = it.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        // Refresh active states (cheap).
        Array.from(list.children).forEach(c => c.classList.remove('is-active'));
        chip.classList.add('is-active');
        // Also refresh card grid active.
        markActiveCard(sel);
      });
      list.appendChild(chip);
    });
    drawer.appendChild(list);
  }

  function escapeHtml(s){
    const map = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
    return String(s).replace(/[&<>"']/g, function(c){ return map[c]; });
  }

  function findGroupByValue(groups, value) {
    return groups.find(g => g.items.some(it => it.value === value)) || null;
  }

  function markActiveCard(sel) {
    const host = sel.previousElementSibling;
    if (!host) return;
    const groups = buildModel(sel);
    const g = findGroupByValue(groups, sel.value);
    Array.from(host.querySelectorAll('.ep-card')).forEach(card => {
      card.classList.toggle('is-active', g && card.dataset.familyKey === g.family.key);
    });
  }

  function render(sel) {
    const { host, grid, drawer } = ensureContainers(sel);
    grid.innerHTML = '';
    const groups = buildModel(sel);

    // Determine initial active group:
    //   - If select.value is non-empty AND that value lives in some group → that group is active.
    //   - Otherwise no card is active, drawer stays closed (user must pick).
    const activeValue = sel.value || '';
    let activeGroup = activeValue ? findGroupByValue(groups, activeValue) : null;

    groups.forEach(g => {
      const card = el('button', 'ep-card');
      card.type = 'button';
      card.dataset.familyKey = g.family.key;
      card.appendChild(logoNode(g.family));
      const nm = el('div', 'ep-name');
      nm.textContent = g.family.name;
      card.appendChild(nm);
      // Tiny count badge for >1 versions.
      if (g.items.length > 1) {
        const cnt = el('div', 'ep-count');
        cnt.textContent = g.items.length + 'v';
        card.appendChild(cnt);
      }
      card.addEventListener('click', () => {
        // First time clicking a fresh card: auto-pick the first non-disabled
        // version so the select gets a value and generate becomes possible.
        const currentlyInGroup = sel.value && g.items.some(it => it.value === sel.value);
        if (!currentlyInGroup) {
          const first = g.items.find(it => !it.disabled);
          if (first) {
            sel.value = first.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
        renderDrawer(drawer, g, sel);
        Array.from(grid.children).forEach(c => c.classList.remove('is-active'));
        card.classList.add('is-active');
      });
      if (activeGroup && activeGroup.family.key === g.family.key) {
        card.classList.add('is-active');
      }
      grid.appendChild(card);
    });

    if (activeGroup) {
      renderDrawer(drawer, activeGroup, sel);
    } else {
      // Closed/empty drawer state — show a small hint instead.
      drawer.classList.remove('open');
      drawer.innerHTML = '<div class="ep-empty-hint">엔진 카드를 선택해 주세요</div>';
    }
  }

  // Public API
  const EnginePicker = {
    init(selectId) {
      const sel = document.getElementById(selectId);
      if (!sel) return;
      render(sel);
      // If outside code changes the value (e.g. programmatically), re-mark.
      sel.addEventListener('change', () => markActiveCard(sel));
    },
    refresh(selectId) {
      const sel = document.getElementById(selectId);
      if (sel) render(sel);
    },
  };

  global.EnginePicker = EnginePicker;
})(window);
