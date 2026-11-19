import type { BrowserContext } from '@playwright/test';

// Local, invented data arranged in the public DOM shapes observed in E54–E57.
// Requests below are fixture-owned; only create's path comes from E63.
export async function installProductionFixture(
  context: BrowserContext,
  options: {
    observedTrailingParagraphs?: boolean;
    /** Synthetic lifecycle only; never changes the production writer. */
    bodyInputLifecycle?: 'rebuild' | 'alternating';
    observedReopenTail?: boolean;
    changedImageCaret?: boolean;
    listAlias?: boolean;
    batchHistory?: boolean;
    /** Synthetic terminal state using the production SINGLE modal DOM contract. */
    singleCoverUpload?: boolean;
    saveFailureAt?: number;
    afterSave?: () => void;
    duplicate?: boolean;
    saveFailure?: boolean;
    safety?: boolean;
    staleSearch?: boolean;
    hungSearch?: boolean;
    inputSearch?: boolean;
    ambiguousEntry?: boolean;
    imageClose?: 'delayed' | 'file-detached' | 'unknown-dialog';
    delayedEditor?: boolean;
    pendingEditorResource?: boolean;
    headerShape?: 'no-banner' | 'no-workbench';
    editorSafety?: boolean;
    staleDraftList?: boolean;
    invisibleDraftListReads?: number;
    fullDraftReview?: 'unique' | 'duplicate' | 'incomplete';
    /** Synthetic E69 notification/normal handler; never a production cache API. */
    restoration?: {
      delay?: number;
      mode?:
        | 'normal'
        | 'repeat'
        | 'residual-body'
        | 'residual-image'
        | 'residual-cover';
      rich?: boolean;
      images?: boolean;
      cover?: boolean;
    };
  } = {},
) {
  const origin = 'https://www.autoengine.com';
  const home = origin + '/jdc/cps/home';
  const editor = '/jdc/dealer/info/Article';
  const list = options.listAlias
    ? '/jdc/dealer/info/contentPublish/content/index-cps2'
    : '/jdc/dealer/info/contentPublish/content/index';
  type SavedArticle = {
    title: string;
    html: string;
    cover?: {
      mode: string;
      count: number;
      loaded: boolean;
      libraryChecked: boolean;
    };
  };
  let saved: SavedArticle | null = null;
  const history: Array<SavedArticle & { recordKey: string }> = [];
  let draftListReads = 0;
  let editorEntries = 0;
  let undoes = 0;
  let saves = 0,
    uploads = 0,
    covers = 0,
    menuInteractions = 0;
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
    'base64',
  );
  const header = `<header role="banner" style="height:50px;display:flex;justify-content:space-between"><span>经营工作台</span><span id="account" style="cursor:pointer">合成账号</span></header><div id="menu" hidden><span>全部业务</span><div><span>其他门店</span><span>角色：企业主账号</span></div><div><span>当前登录</span><strong>合成门店</strong><span>角色：市场经理</span></div></div><script>window.menuClicks=0;account.onmouseenter=()=>{menu.hidden=false;void fetch('/fixture/menu-interaction',{method:'POST'})};account.onmouseleave=()=>menu.hidden=true;account.onclick=()=>{window.menuClicks++;void fetch('/fixture/menu-interaction',{method:'POST'});menu.hidden=!menu.hidden}</script>`;
  await context.route(origin + '/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/fixture/pending-editor-resource') return;
    if (url.pathname === '/fixture/menu-interaction') {
      menuInteractions++;
      return route.fulfill({ json: {} });
    }
    if (url.pathname === '/fixture/unrelated')
      return route.fulfill({ json: {} });
    if (url.pathname === '/fixture/official-undo') {
      undoes++;
      return route.fulfill({ json: {} });
    }
    if (url.pathname === '/fixture/image')
      return route.fulfill({ contentType: 'image/png', body: png });
    if (url.pathname === '/fixture/upload') {
      uploads++;
      return route.fulfill({ json: { key: 'body-' + uploads } });
    }
    if (url.pathname === '/fixture/cover') {
      covers++;
      return route.fulfill({ json: {} });
    }
    if (url.pathname === '/motor/dealer_admin/go_api/article/create') {
      saves++;
      const failed = options.saveFailure || options.saveFailureAt === saves;
      if (!failed) {
        saved = route.request().postDataJSON();
        if (options.batchHistory && saved)
          history.push({ ...saved, recordKey: String(500 + saves) });
      }
      options.afterSave?.();
      return route.fulfill({
        json: { status: failed ? 5000 : 0 },
      });
    }
    if (url.pathname === '/motor/dealer_admin/go_api/marketing/article/list') {
      const entries =
        ++draftListReads <= (options.invisibleDraftListReads ?? 0)
          ? []
          : options.batchHistory
            ? history
            : saved
              ? Array.from(
                  { length: options.fullDraftReview === 'duplicate' ? 2 : 1 },
                  () => ({ ...saved!, recordKey: '501' }),
                )
              : [];
      if (options.staleDraftList)
        await new Promise((resolve) => setTimeout(resolve, 500));
      return route.fulfill({
        json: {
          status: 0,
          data: {
            count: entries.length,
            has_more: false,
            list: entries.map((e) => ({ ...e, pgc_status: 3 })),
          },
        },
      });
    }
    if (url.pathname === '/fixture/list' && options.hungSearch) return;
    if (url.pathname === '/fixture/list')
      return route.fulfill({
        json:
          (options.batchHistory ? history : saved) ||
          (options.duplicate
            ? { title: url.searchParams.get('title'), html: '<p>old</p>' }
            : null),
      });
    let body: string;
    if (url.pathname === '/jdc/cps/home')
      body = '<span>您好！123456 合成门店</span>';
    else if (url.pathname.endsWith('/sceneMarketing'))
      body = `<a href="https://m.dcdapp.com/motor/inapp/dshop/?dealer_id=123456">店铺</a><div><div><span>文章资讯</span></div><button onclick="location.href='${editor}'"><span>立即发布</span></button></div>`;
    else if (url.pathname === list)
      body = `<span>状态:</span><div class="arco-radio-group" role="radiogroup"><label class="arco-radio-button"><input type="radio" value=""><span>全部</span></label><label class="arco-radio-button" id="draftTab"><input type="radio" value="3"><span>草稿箱</span></label></div><span class="arco-tag">草稿箱</span><span class="arco-tag">草稿箱</span><input placeholder="请搜索标题关键字"><div id="results"></div><script>
      draftTab.onclick=()=>draftTab.classList.add('active');
      document.querySelector('input[placeholder="请搜索标题关键字"]').onkeydown=async(e)=>{if(e.key!=='Enter')return;results.innerHTML='<span>加载中</span>';const item=await(await fetch('/fixture/list?title='+encodeURIComponent(e.target.value))).json();results.innerHTML='';if(!item){results.textContent='没有符合条件的内容';return;}const c=document.createElement('div');c.className='articleBox-fixture';const p=document.createElement('p');p.className='articleTitle-fixture';p.textContent=item.title;c.append(p);c.insertAdjacentHTML('beforeend','<span>草稿箱</span><span>文章资讯</span><button>编辑</button>');c.querySelector('button').onclick=()=>location.href='${editor}?pgc_id=501&pgc_status=3';results.append(c);const end=document.createElement('span');end.textContent='暂无更多数据';results.append(end);};</script>`;
    else if (url.pathname === editor)
      body = `<textarea placeholder="请输入文章标题（5-30个汉字）"></textarea><div class="syl-toolbar"><span class="syl-toolbar-tool image"><button id="imageTool">图片</button></span></div><div contenteditable="true" id="body"><p><br class="ProseMirror-trailingBreak"></p></div><button id="save">存草稿</button><button onclick="fetch('/fixture/cover')">选择封面</button><script>
      const existing=${JSON.stringify(url.searchParams.has('pgc_id') ? (options.batchHistory ? (history.find((item) => item.recordKey === url.searchParams.get('pgc_id')) ?? null) : saved) : null)};
      if(existing){document.querySelector('textarea').value=existing.title;body.innerHTML=existing.html;if(!body.lastElementChild||body.lastElementChild.tagName!=="P"||body.lastElementChild.textContent){const tail=document.createElement("p");tail.innerHTML='<br class="ProseMirror-trailingBreak">';body.append(tail);}else if(body.lastElementChild.innerHTML===""){body.lastElementChild.innerHTML='<br class="ProseMirror-trailingBreak">';}}
      if(!existing)body.innerHTML='<p><span class="syl-placeholder ProseMirror-widget" style="position:absolute;user-select:none" ignoreel="true" contenteditable="false">请输入正文</span><img class="ProseMirror-separator" alt=""><br class="ProseMirror-trailingBreak"></p>';
      // Model the platform selection plugin only for exact known empty P shapes.
      // Raw contenteditable may leave selection in BODY or before a prior image.
      body.addEventListener('mousedown',(event)=>{const p=event.target.closest('p');if(p?.parentElement!==body)return;const caret=p.childNodes.length===1&&p.firstElementChild?.matches('br.ProseMirror-trailingBreak');const placeholder=p.childNodes.length===3&&p.children.length===3&&p.children[0].matches('span.syl-placeholder.ProseMirror-widget[contenteditable="false"][ignoreel="true"]')&&p.children[0].childNodes.length===1&&p.children[0].textContent==='请输入正文'&&p.children[1].matches('img.ProseMirror-separator')&&p.children[2].matches('br.ProseMirror-trailingBreak');if(!caret&&!placeholder)return;event.preventDefault();body.focus();const range=document.createRange();range.selectNodeContents(p);range.collapse(true);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);});
      body.onbeforeinput=(e)=>{const widget=body.querySelector('.syl-placeholder');if(!widget||e.inputType!=='insertText')return;e.preventDefault();const p=widget.parentElement;p.textContent=e.data;const r=document.createRange();r.selectNodeContents(p);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);};
      body.onkeydown=(e)=>{if(e.key!=='Enter'||e.shiftKey)return;e.preventDefault();const p=document.createElement('p');p.innerHTML='<br class="ProseMirror-trailingBreak">';body.append(p);const r=document.createRange();r.selectNodeContents(p);r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r);};
      imageTool.onclick=()=>{const d=document.createElement('div');d.setAttribute('role','dialog');d.innerHTML='<input type="file"><div id="preview"></div><button disabled>确定</button>';document.body.append(d);d.querySelector('input').onchange=async()=>{const data=await(await fetch('/fixture/upload',{method:'POST'})).json();const img=document.createElement('img');img.src='/fixture/image?web_uri='+data.key;img.width=100;img.onload=()=>d.querySelector('button').disabled=false;d.querySelector('#preview').append(img);d.querySelector('button').onclick=()=>{const block=document.createElement('div');block.setAttribute('__syl_tag','true');block.setAttribute('contenteditable','false');block.setAttribute('draggable','true');block.innerHTML='<templ style="display:none"><img web_uri="'+data.key+'" src="'+img.src+'"></templ><div class="pgc-image"><div class="pgc-img-wrapper"><img width="100" web_uri="'+data.key+'" src="'+img.src+'"></div></div>';body.lastElementChild.replaceWith(block);const p=document.createElement('p');p.innerHTML='<br class="ProseMirror-trailingBreak">';body.append(p);d.remove();};};};
      save.onclick=()=>fetch('/motor/dealer_admin/go_api/article/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:document.querySelector('textarea').value,html:(()=>{const content=body.cloneNode(true);content.querySelectorAll("[ignoreel=true]").forEach(n=>n.remove());return content.innerHTML;})()})});</script>`;
    else return route.abort();
    if (url.pathname === list && options.fullDraftReview) {
      body = `<label class="arco-radio-button" id="reviewTab"><input type="radio" value="3"><span>草稿箱</span></label><input placeholder="请搜索标题关键字"><input placeholder="开始日期"><input placeholder="结束日期"><input placeholder="请选择文章类型"><div id="results">${options.staleDraftList ? '<div class="articleBox-fixture"><p>旧草稿</p><span>草稿箱</span><span>文章资讯</span></div><span>暂无更多数据</span>' : ''}</div><script>
      reviewTab.onclick=async()=>{reviewTab.querySelector('input').checked=true;const payload=await(await fetch('/motor/dealer_admin/go_api/marketing/article/list?show_new_style=1&offset=0&limit=20&pgc_status=3&title=')).json();results.innerHTML='';for(const item of payload.data.list){const c=document.createElement('div');c.className='articleBox-fixture';const t=document.createElement('p');t.textContent=item.title;c.append(t);c.insertAdjacentHTML('beforeend','<span>草稿箱</span><span>文章资讯</span><button>编辑</button>');c.querySelector('button').onclick=()=>location.href='${editor}?pgc_id='+item.recordKey+'&pgc_status=3';results.append(c);} ${options.fullDraftReview === 'incomplete' ? '' : "const end=document.createElement('span');end.textContent='暂无更多数据';results.append(end);"}};</script>`;
    }
    // Live 2026-10-16: a saved one-tail editor reopens with two tail P nodes.
    // Reproduce the observed roundtrip; this does not assert server serialization internals.
    if (url.pathname === editor && options.observedReopenTail) {
      body = body.replace(
        'body.innerHTML=existing.html;',
        'body.innerHTML=existing.html;if(body.lastElementChild?.tagName!=="P"||body.lastElementChild.innerHTML!==""){body.insertAdjacentHTML("beforeend",\'<p><br class="ProseMirror-trailingBreak"></p>\');}',
      );
    }
    if (url.pathname === editor && options.observedTrailingParagraphs) {
      body =
        '<style>#body > p { min-height:24px; line-height:24px; margin:16px 0; }</style>' +
        body;
      body = body.replace(
        'body.lastElementChild.replaceWith(block);',
        "if(body.lastElementChild.querySelector('.syl-placeholder'))body.lastElementChild.innerHTML='<br class=\"ProseMirror-trailingBreak\">';body.lastElementChild.replaceWith(block);",
      );
      body = body.replace(
        'getSelection().addRange(r);};',
        'getSelection().addRange(r);ensureTail();};',
      );
      body = body.replace(
        'body.onkeydown=',
        `function ensureTail(){for(const p of body.children){if(p.tagName!=='P')continue;for(const br of p.querySelectorAll('br.ProseMirror-trailingBreak'))br.classList.remove('ProseMirror-trailingBreak');const last=p.lastChild;if(last?.nodeName==='BR'&&(!p.textContent||last.previousSibling?.nodeName==='BR'))last.classList.add('ProseMirror-trailingBreak');}if(body.lastElementChild?.textContent){const tail=document.createElement('p');tail.innerHTML='<br class="ProseMirror-trailingBreak">';body.append(tail);}else if(body.lastElementChild.innerHTML===""){body.lastElementChild.innerHTML='<br class="ProseMirror-trailingBreak">';}}body.addEventListener('input',ensureTail);body.onkeydown=`,
      );
      body = body.replace(
        'body.lastElementChild.replaceWith(block);',
        'body.lastElementChild.after(block);',
      );
      if (options.changedImageCaret)
        body = body.replace(
          'body.lastElementChild.after(block);',
          "body.lastElementChild.textContent='operator content';body.lastElementChild.after(block);",
        );
      body = body.replace(
        "body.onkeydown=(e)=>{if(e.key!=='Enter'",
        "body.onkeydown=(e)=>{if(e.key==='Delete'){const n=getSelection().anchorNode;const p=n?.nodeType===3?n.parentElement:n;if(p?.tagName==='P'&&!p.textContent&&p.nextElementSibling?.hasAttribute('__syl_tag')){e.preventDefault();p.remove();return;}}if(e.key!=='Enter'",
      );
    }
    if (url.pathname === editor) {
      if (options.bodyInputLifecycle) {
        body += `<script>
          window.bodyInputActions=[];
          document.addEventListener('change',event=>{
            const input=event.target,modal=input.closest('[role=dialog]');
            if(input.type!=='file'||!modal||!modal.querySelector('#preview'))return;
            const actions=window.bodyInputActions;
            const mode=${JSON.stringify(options.bodyInputLifecycle)}==='rebuild'?'rebuilt':['retained','cleared','unmounted'][actions.length%3];
            const action={mode,selected:1,confirmed:0};actions.push(action);
            modal.addEventListener('click',event=>{if(event.target.tagName==='BUTTON'&&event.target.textContent==='确定')action.confirmed++;},true);
            if(mode==='rebuilt'){const replacement=document.createElement('input');replacement.type='file';input.replaceWith(replacement);}
            if(mode==='cleared')input.value='';
            if(mode==='unmounted')input.remove();
          });
        </script>`;
      }
      editorEntries++;
      // Observed empty cover shape: the plus icon is a UI control, not a cover.
      body = body.replace(
        '<button id="save">',
        '<section id="cover"><div>展示封面</div><label><input type="radio" name="cover" checked><span>单图</span></label><label><input type="radio" name="cover"><span>三图</span></label><div class="article-cover-images"><div class="article-cover-add"><img class="plus-icon" width="20" height="20" src="/fixture/image"></div></div></section><button id="save">',
      );
      if (options.singleCoverUpload) {
        // Deliberately invented completion data. The production driver must read
        // the retained File, terminal label, HTTPS preview and checkbox itself.
        body += `<style>.arco-modal-wrapper{position:fixed;inset:0;display:grid;place-items:center}.arco-modal{background:white;padding:24px}.arco-modal-mask{position:fixed;inset:0;background:#0003}</style><script>
          window.coverLibraryChecked=true;
          document.querySelector('.article-cover-add').onclick=()=>{
            const root=document.createElement('div');root.id='cover-layer';
            root.innerHTML='<div class="arco-modal-mask"></div><div class="arco-modal-wrapper"><div class="arco-modal" role="dialog"><div>上传图片</div><button>选择图片</button><input type="file" multiple accept="image/jpeg,image/jpg,image/png,image/x-png,image/gif"><button aria-label="Close">×</button></div></div>';
            document.body.append(root);
            root.querySelector('input').onchange=()=>{
              const modal=root.querySelector('[role=dialog]');
              modal.insertAdjacentHTML('beforeend','<img width="100" height="100" src="https://www.autoengine.com/fixture/image?cover=single"><span>上传完成，可以拖拽调整图片顺序</span><label><input type="checkbox" checked>保存到素材库</label><button id="confirm-cover">确定</button><button>取消</button>');
              modal.querySelector('#confirm-cover').onclick=()=>{
                window.coverLibraryChecked=modal.querySelector('input[type=checkbox]').checked;
                document.querySelector('.article-cover-images').replaceChildren(modal.querySelector('img').cloneNode(true));root.remove();
              };
            };
          };
          document.querySelector('#save').onclick=()=>{
            const images=[...document.querySelectorAll('.article-cover-images img')];
            fetch('/motor/dealer_admin/go_api/article/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:document.querySelector('textarea').value,html:(()=>{const content=body.cloneNode(true);content.querySelectorAll('[ignoreel=true]').forEach(n=>n.remove());return content.innerHTML;})(),cover:{mode:document.querySelector('#cover input').checked?'single':'other',count:images.length,loaded:images.every(img=>img.complete&&img.naturalWidth>0),libraryChecked:window.coverLibraryChecked}})});
          };
        </script>`;
      }
    }
    if (
      url.pathname === editor &&
      options.restoration &&
      !url.searchParams.has('pgc_id') &&
      (!undoes || options.restoration.mode === 'repeat')
    ) {
      const mode = options.restoration.mode ?? 'normal';
      const restoredImage =
        '<div __syl_tag="true" contenteditable="false" draggable="true"><templ style="display:none"><img web_uri="restored" src="/fixture/image?web_uri=restored"></templ><div class="pgc-image"><div class="pgc-img-wrapper"><img width="100" height="100" web_uri="restored" src="/fixture/image?web_uri=restored"></div></div></div>';
      if (options.restoration.images)
        body =
          '<link rel="preload" as="image" href="/fixture/image?web_uri=restored">' +
          body;
      body += `<script>document.addEventListener('DOMContentLoaded',()=>setTimeout(()=>{
        document.querySelector('textarea').value='restored old title';
        body.innerHTML=${JSON.stringify(options.restoration.rich ? '<h1><strong>restored heading</strong></h1><blockquote><p>old quote</p></blockquote><p><br class="ProseMirror-trailingBreak"></p>' : '<p>restored body</p><p><br class="ProseMirror-trailingBreak"></p>')};
        ${options.restoration.images ? `body.firstElementChild.insertAdjacentHTML('afterend',${JSON.stringify(restoredImage)});` : ''}
        ${options.restoration.cover ? `document.querySelector('.article-cover-images').innerHTML='<img width="100" height="100" src="/fixture/image">';` : ''}
        const note=document.createElement('span');note.className='arco-message-content';note.textContent='已恢复上次编辑未保存的内容';
        const undo=document.createElement('span');undo.className='publish-message-opr';undo.textContent='撤销';note.append(undo);document.body.append(note);
        undo.onclick=async()=>{await fetch('/fixture/official-undo',{method:'POST'});document.querySelector('textarea').value='';body.innerHTML=${JSON.stringify(mode === 'residual-body' ? '<p>residual body</p>' : mode === 'residual-image' ? '<p><img width="100" height="100" src="/fixture/image"></p>' : '<p><br class="ProseMirror-trailingBreak"></p>')};${mode === 'residual-cover' ? "document.querySelector('.article-cover-images').innerHTML='<img width=100 height=100 src=\"/fixture/image\">';" : 'document.querySelector(\'.article-cover-images\').innerHTML=\'<div class="article-cover-add"><img class="plus-icon" width=20 height=20 src="/fixture/image"></div>\';'}note.remove();};
      },${options.restoration.delay ?? 0}));</script>`;
    }
    if (options.imageClose && url.pathname === editor) {
      // A collapsed dialog is hidden to Playwright but still has client rects.
      // The file input can unmount before its closing dialog is removed.
      body = body.replace(
        'd.remove();',
        `d.style.cssText='position:fixed;width:0;height:0;overflow:hidden';${options.imageClose !== 'delayed' ? "d.querySelector('input').remove();" : ''}setTimeout(()=>{d.remove();${options.imageClose === 'unknown-dialog' ? "const other=document.createElement('div');other.setAttribute('role','dialog');other.textContent='额外操作确认';document.body.append(other);" : ''}},1000);`,
      );
    }
    if (options.ambiguousEntry && url.pathname.endsWith('/sceneMarketing')) {
      body = body.replace('</button>', '</button><button>立即发布</button>');
    }
    if (options.inputSearch && url.pathname === list) {
      body = body.replace(
        ".onkeydown=async(e)=>{if(e.key!=='Enter')return;",
        '.oninput=async(e)=>{',
      );
    }
    if (options.staleSearch && url.pathname === list) {
      body = body
        .replace(
          '<div id="results"></div>',
          '<div id="results">没有符合条件的内容</div>',
        )
        .replace(
          "if(e.key!=='Enter')return;",
          "if(e.key!=='Enter')return;await fetch('/fixture/unrelated');return;",
        );
    }
    if (options.delayedEditor && url.pathname === editor) {
      body = `<div id="editorMount"></div><script>setTimeout(()=>{editorMount.innerHTML=${JSON.stringify(body).replaceAll('<', '\\u003c')};editorMount.querySelectorAll('script').forEach(old=>{const s=document.createElement('script');s.textContent=old.textContent;old.replaceWith(s)});},750)</script>`;
    }
    if (options.pendingEditorResource && url.pathname === editor)
      body += '<img hidden src="/fixture/pending-editor-resource">';
    const renderedHeader =
      options.headerShape === 'no-banner'
        ? header
            .replace('<header role="banner"', '<div id="sessionHeader"')
            .replace('</header>', '</div>')
        : options.headerShape === 'no-workbench'
          ? header.replace('经营工作台', '合成后台')
          : header;
    return route.fulfill({
      contentType: 'text/html',
      body:
        '<!doctype html><meta charset="utf-8">' +
        renderedHeader +
        body +
        (options.safety || (options.editorSafety && url.pathname === editor)
          ? '<div role="dialog">安全验证</div>'
          : ''),
    });
  });
  return {
    home,
    editorEntries: () => editorEntries,
    undoes: () => undoes,
    renameSaved: (title: string) => {
      if (!saved) throw Error('not saved');
      saved.title = title;
    },
    savedArticles: () => structuredClone(history),
    saves: () => saves,
    draftListReads: () => draftListReads,
    uploads: () => uploads,
    coverActions: () => covers,
    menuInteractions: () => menuInteractions,
  };
}
