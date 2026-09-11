interface EventCamera { state: string; attributes: { capabilities?: Record<string, { available: boolean }>; viewer_card?: boolean; friendly_name?: string } }
interface EventsHA { language: string; states: Record<string, EventCamera>; connection: EventTarget; fetchWithAuth(path: string, init?: RequestInit): Promise<Response> }
interface EventsConfig { entities?: string[]; title?: string }
interface StoredEvent { entity_id: string; id: string; start: string; end: string; thumbnail: boolean }
const EVENTS_TEXT = {
  nl: { title:'Gebeurtenissen', all:'Alle camera’s', camera:'Camera', date:'Datum', show:'Opnames tonen', hint:'Kies een dag en toon de bestaande HomeBase-opnames.', loading:'Opnames laden…', preparing:'Opname voorbereiden…', calendar:'Kalender', month:'Maand', calendarHint:'• Opnames op deze HomeBase (alle camera’s)', calendarError:'Opnamedagen niet beschikbaar voor deze gebruiker of HomeBase.', prev:'Vorige opname', next:'Volgende opname', close:'Sluiten', pagePrev:'Vorige pagina', pageNext:'Volgende pagina', none:'Geen opnames op deze dag voor deze camera.', results:'opnames', time:'HomeBase-tijd', noThumb:'Geen voorbeeldbeeld', expired:'Opnamelink verlopen. Laad de datum opnieuw.', error:'Opnames niet beschikbaar. Probeer de datum opnieuw.', incomplete:'De volledige dag kon niet worden bevestigd. Probeer opnieuw.', live:'Sluit de livebeelden voordat je opnames laadt.', stopping:'De vorige live-sessie wordt nog afgesloten. Probeer het zo opnieuw.', busy:'Een andere opname wordt voorbereid. Probeer het zo opnieuw.', stopped:'Gestopt. Tik op Opnames tonen om verder te kijken.' },
  en: { title:'Events', all:'All cameras', camera:'Camera', date:'Date', show:'Show recordings', hint:'Choose a day to view existing HomeBase recordings.', loading:'Loading recordings…', preparing:'Preparing recording…', calendar:'Calendar', month:'Month', calendarHint:'• Recordings on this HomeBase (all cameras)', calendarError:'Recording days unavailable for this user or HomeBase.', prev:'Previous recording', next:'Next recording', close:'Close', pagePrev:'Previous page', pageNext:'Next page', none:'No recordings for this camera and day.', results:'recordings', time:'HomeBase time', noThumb:'No preview available', expired:'Recording link expired. Load the date again.', error:'Recordings unavailable. Load the date again.', incomplete:'The complete day could not be confirmed. Try again.', live:'Close live viewers before loading recordings.', stopping:'The previous live session is still stopping. Try again shortly.', busy:'Another recording is being prepared. Try again shortly.', stopped:'Stopped. Tap Show recordings to continue.' }
};

/** Finite, user-initiated HomeBase browsing. No live sessions or polling. */
export class EufyEventsCard extends HTMLElement {
  private config: EventsConfig = {};
  private ha?: EventsHA;
  private records: StoredEvent[] = [];
  private days = new Set<string>();
  private page = 0;
  private selected = -1;
  private controller?: AbortController;
  private job: Promise<void> = Promise.resolve();
  private active = false;
  private urls = new Map<string,string>();
  private playback = new EufyRecordingPlayback();
  private observer?: IntersectionObserver;
  private cameraKey = '';
  private loadedDate = '';
  private visibilityChanged = () => { if (document.visibilityState !== 'visible') this.stop(); };
  private leave = () => this.stop();
  private q<T extends HTMLElement>(selector: string) { return this.shadowRoot!.querySelector<T>(selector)!; }
  private get text() { return EVENTS_TEXT[this.ha?.language?.startsWith('nl') ? 'nl' : 'en']; }
  private cameras() { return Object.keys(this.ha?.states ?? {}).filter(id => id.startsWith('camera.') && this.ha!.states[id].attributes.viewer_card && this.ha!.states[id].attributes.capabilities?.recordings?.available !== false && (!this.config.entities || this.config.entities.includes(id))).sort(); }
  private name(id: string) { return this.ha?.states[id]?.attributes.friendly_name ?? id; }
  private filtered() { const camera = this.q<HTMLSelectElement>('.camera').value; return this.records.filter(r => this.cameras().includes(r.entity_id) && (!camera || r.entity_id === camera)); }
  static getStubConfig() { return {}; }
  getCardSize() { return 8; }
  getGridOptions() { return { columns: 12, rows: 'auto', min_columns: 6 }; }
  constructor() {
    super(); this.attachShadow({mode:'open'});
    // Only static markup enters innerHTML; remote labels use textContent.
    this.shadowRoot!.innerHTML = `<style>
      :host{display:block}*{box-sizing:border-box}[hidden]{display:none!important}ha-card{display:block;padding:20px;border-radius:16px;color:var(--primary-text-color,#152028);background:var(--card-background-color,#fff)}
      h2{font-size:21px;margin:0 0 16px}button,input,select{font:inherit;color:inherit}button{cursor:pointer;min-height:42px;padding:8px 13px;border:1px solid var(--divider-color,#d4dadd);border-radius:9px;background:var(--secondary-background-color,#f2f5f6)}button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid var(--primary-color,#008c96);outline-offset:2px}
      .filters{display:flex;flex-wrap:wrap;align-items:end;gap:12px}.filters label{display:grid;gap:5px;font-size:13px}.filters select,.filters input,.month{min-height:42px;max-width:100%;padding:8px;border:1px solid var(--divider-color,#d4dadd);border-radius:8px;background:var(--card-background-color,#fff)}.show{background:var(--primary-color,#008c96);color:var(--text-primary-color,#fff);border-color:transparent}summary{cursor:pointer;padding:14px 0;width:max-content}.calendar{max-width:360px}.days{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-top:10px}.day{padding:6px;position:relative}.day.marked:after{content:'•';position:absolute;bottom:0;left:0;right:0;color:var(--primary-color,#008c96)}.day.chosen{outline:2px solid var(--primary-color,#008c96)}.weekday{text-align:center;font-size:12px;opacity:.65}.legend,.status,.page-info{font-size:13px;color:var(--secondary-text-color,#56656b)}.status{margin:16px 0;min-height:18px}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr));gap:12px}.event{padding:0;overflow:hidden;text-align:left;background:transparent}.preview{display:grid;place-items:center;position:relative;overflow:hidden;width:100%;aspect-ratio:16/9;background:var(--secondary-background-color,#e9eff0);font-size:12px;color:var(--secondary-text-color,#56656b)}.preview img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#10161e}.meta{padding:10px;display:grid;gap:5px}.camera-name{font-weight:600;font-size:14px}.event-time{font-size:13px;opacity:.8}.pagination{display:flex;gap:10px;justify-content:center;align-items:center;margin-top:18px}
      dialog{width:min(1000px,95vw);max-width:95vw;padding:0;border:0;border-radius:16px;background:var(--card-background-color,#fff);color:var(--primary-text-color,#152028)}dialog::backdrop{background:#000b}.player-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;flex-wrap:wrap}.player-title{font-weight:600}.player-status{padding:0 16px 12px}video{display:block;width:100%;max-height:65vh;background:#10161e}.player-nav{display:flex;gap:10px;justify-content:center;padding:14px}
      @media(max-width:450px){ha-card{padding:14px}.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.filters label:first-child{flex:1;min-width:130px}.event-time{font-size:11px}}
    </style><ha-card><h2></h2><div class="filters"><label><span data-text="camera"></span><select class="camera"></select></label><label><span data-text="date"></span><input class="date" type="date"></label><button class="show" data-text="show"></button></div><details><summary data-text="calendar"></summary><div class="calendar"><input class="month" type="month"><div class="days"></div><p class="legend"></p></div></details><div class="status" role="status" aria-live="polite"></div><div class="tiles"></div><div class="pagination" hidden><button class="page-prev" data-text="pagePrev"></button><span class="page-info"></span><button class="page-next" data-text="pageNext"></button></div></ha-card><dialog aria-labelledby="events-player-title"><div class="player-bar"><span class="player-title" id="events-player-title"></span><button class="close" data-text="close"></button></div><div class="player-status" role="status" aria-live="polite"></div><video playsinline controls hidden></video><div class="player-nav"><button class="previous" data-text="prev"></button><button class="next" data-text="next"></button></div></dialog>`;
    const today = new Date(); const date = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    this.q<HTMLInputElement>('.date').value = date; this.q<HTMLInputElement>('.month').value = date.slice(0,7);
    this.q('.show').onclick = () => this.load();
    this.q('.camera').onchange = () => { this.page=0; this.run(signal=>this.renderEvents(signal)); };
    this.q('.date').onchange = () => { this.q<HTMLInputElement>('.month').value=this.q<HTMLInputElement>('.date').value.slice(0,7); this.load(); };
    this.q<HTMLDetailsElement>('details').ontoggle = () => { if(this.q<HTMLDetailsElement>('details').open) this.loadCalendar(); };
    this.q('.month').onchange = () => this.loadCalendar();
    this.q('.page-prev').onclick = () => { this.page--; this.run(signal=>this.renderEvents(signal)); };
    this.q('.page-next').onclick = () => { this.page++; this.run(signal=>this.renderEvents(signal)); };
    this.q('.previous').onclick = () => this.play(this.selected-1);
    this.q('.next').onclick = () => this.play(this.selected+1);
    this.q('.close').onclick = () => this.closePlayer();
    this.q('dialog').addEventListener('cancel', e=>{e.preventDefault();this.closePlayer();});
    this.labels(); this.q('.status').textContent=this.text.hint;
  }
  setConfig(config: EventsConfig) {
    if (config.entities && (!Array.isArray(config.entities) || config.entities.length>100 || config.entities.some(id=>!/^camera\.[a-z0-9_]+$/.test(id)))) throw new Error('Select Eufy Viewer camera entities');
    this.stop(); this.config={...config}; this.cameraKey=''; this.labels();
  }
  set hass(value: EventsHA) {
    if (this.ha?.connection !== value.connection) { this.stop(); this.ha?.connection.removeEventListener('disconnected',this.leave); if(this.isConnected)value.connection.addEventListener('disconnected',this.leave); }
    const previous = this.cameras();
    this.ha=value;
    if (previous.some(id => !this.cameras().includes(id))) this.stop();
    this.labels();
  }
  connectedCallback() {
    document.addEventListener('visibilitychange',this.visibilityChanged);window.addEventListener('pagehide',this.leave);this.ha?.connection.addEventListener('disconnected',this.leave);
    this.observer=new IntersectionObserver(entries=>{if(!entries[0]?.isIntersecting)this.stop();});this.observer.observe(this);
  }
  disconnectedCallback() {this.stop();this.observer?.disconnect();document.removeEventListener('visibilitychange',this.visibilityChanged);window.removeEventListener('pagehide',this.leave);this.ha?.connection.removeEventListener('disconnected',this.leave);}
  private labels() {
    for(const element of Array.from(this.shadowRoot!.querySelectorAll<HTMLElement>('[data-text]')))element.textContent=this.text[element.dataset.text as keyof typeof this.text];
    this.q('h2').textContent=this.config.title||this.text.title;this.q('.month').setAttribute('aria-label',this.text.month);
    const cameras=this.cameras(), key=JSON.stringify(cameras.map(id=>[id,this.name(id)]))+this.text.all;
    if(key!==this.cameraKey){this.cameraKey=key;const select=this.q<HTMLSelectElement>('.camera'), selected=select.value;select.replaceChildren();for(const id of ['',...cameras]){const option=document.createElement('option');option.value=id;option.textContent=id?this.name(id):this.text.all;select.append(option);}select.value=cameras.includes(selected)?selected:'';}
    this.q<HTMLButtonElement>('.show').disabled=!cameras.length;
    if (!cameras.length) { this.stop(); this.q('.status').textContent=this.ha?.language?.startsWith('nl')?'Geen camera met beschikbare opnames. Bekijk de camerakaart voor de reden.':'No camera with available recordings. See the camera card for the reason.'; }
  }
  private clearVideo() {const v=this.q<HTMLVideoElement>('video');v.pause();v.removeAttribute('src');v.load();v.hidden=true;this.playback.clear();}
  private closePlayer() {this.controller?.abort();this.clearVideo();const dialog=this.q<HTMLDialogElement>('dialog');if(dialog.open)dialog.close();}
  private stop() {this.closePlayer();for(const url of this.urls.values())URL.revokeObjectURL(url);this.urls.clear();if(this.active)this.q('.status').textContent=this.text.stopped;}
  private run(action: (signal:AbortSignal)=>Promise<void>) {
    const settling=this.active;this.controller?.abort();this.clearVideo();
    const controller=this.controller=new AbortController();this.active=true;
    this.job=this.job.catch(()=>{}).then(async()=>{
      // Let HA observe our cancelled socket before starting another P2P operation.
      if(settling)await new Promise(resolve=>setTimeout(resolve,750));
      if(controller.signal.aborted || !this.isConnected || document.visibilityState!=='visible')return;
      try{await action(controller.signal);}catch(error){if(!controller.signal.aborted){const message=this.failure(error);this.q('.status').textContent=message;this.q('.player-status').textContent=message;}}
      finally{if(this.controller===controller)this.active=false;}
    });
  }
  private failure(error: unknown) {const code=error instanceof Error?error.message:'';return code==='live_busy'?this.text.live:code==='live_stopping'?this.text.stopping:code==='recording_busy'?this.text.busy:code==='recording_expired'?this.text.expired:code==='history_incomplete'?this.text.incomplete:this.text.error;}
  private async fetch(path: string, signal:AbortSignal) {signal.throwIfAborted();const response=await this.ha!.fetchWithAuth(path,{signal});if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error);}return response;}
  private query() {return `/api/eufy_viewer/events?entities=${encodeURIComponent(this.cameras().join(','))}`;}
  private load() {
    if (!this.cameras().length) return;
    this.closePlayer();this.records=[];this.page=0;this.q('.tiles').replaceChildren();this.q('.pagination').hidden=true;
    for(const url of this.urls.values())URL.revokeObjectURL(url);this.urls.clear();
    this.loadedDate=this.q<HTMLInputElement>('.date').value;const date=this.loadedDate;
    this.run(async signal=>{
      this.q('.status').textContent=this.text.loading;
      const data=await(await this.fetch(`${this.query()}&date=${date}`,signal)).json();signal.throwIfAborted();
      if(data.complete!==true || !Array.isArray(data.recordings) || data.recordings.length>10000 || data.recordings.some((r:StoredEvent)=>!this.cameras().includes(r.entity_id)||!/^[a-f0-9]{32}$/.test(r.id)||typeof r.start!=='string'||typeof r.end!=='string'))throw new Error('history_incomplete');
      this.records=data.recordings;await this.renderEvents(signal);
    });
  }
  private loadCalendar() {
    if (!this.cameras().length) return;
    const month=this.q<HTMLInputElement>('.month').value;
    this.run(async signal=>{
      this.days.clear();this.renderCalendar();this.q('.legend').textContent=this.text.loading;
      try{const data=await(await this.fetch(`${this.query()}&month=${month}`,signal)).json();signal.throwIfAborted();if(!Array.isArray(data.days)||data.days.length>31)throw new Error();this.days=new Set(data.days);this.renderCalendar();this.q('.legend').textContent=this.text.calendarHint;}
      catch(error){if(!signal.aborted)this.q('.legend').textContent=this.text.calendarError;}
    });
  }
  private renderCalendar() {
    const month=this.q<HTMLInputElement>('.month').value, start=new Date(`${month}-01T12:00:00`), root=this.q('.days');root.replaceChildren();if(!Number.isFinite(start.valueOf()))return;
    for(let i=0;i<7;i++){const label=document.createElement('span');label.className='weekday';label.textContent=new Date(2026,8,7+i).toLocaleDateString(this.ha?.language,{weekday:'narrow'});root.append(label);}
    for(let i=0;i<(start.getDay()+6)%7;i++)root.append(document.createElement('span'));
    const count=new Date(start.getFullYear(),start.getMonth()+1,0).getDate();
    for(let n=1;n<=count;n++){const day=`${month}-${String(n).padStart(2,'0')}`,button=document.createElement('button');button.className='day'+(this.days.has(day)?' marked':'')+(this.q<HTMLInputElement>('.date').value===day?' chosen':'');button.textContent=String(n);button.setAttribute('aria-label',day+(this.days.has(day)?` · ${this.text.results}`:''));button.onclick=()=>{this.q<HTMLInputElement>('.date').value=day;this.renderCalendar();this.load();};root.append(button);}
  }
  private async renderEvents(signal:AbortSignal) {
    const records=this.filtered(),root=this.q('.tiles');root.replaceChildren();this.page=Math.max(0,Math.min(this.page,Math.ceil(records.length/12)-1));
    this.q('.status').textContent=records.length?`${records.length} ${this.text.results} · ${this.loadedDate} · ${this.text.time}`:this.text.none;
    this.q('.pagination').hidden=records.length<=12;this.q('.page-info').textContent=`${this.page+1} / ${Math.max(1,Math.ceil(records.length/12))}`;
    this.q<HTMLButtonElement>('.page-prev').disabled=this.page===0;this.q<HTMLButtonElement>('.page-next').disabled=(this.page+1)*12>=records.length;
    const pending:{record:StoredEvent;preview:HTMLElement}[]=[];
    for(const [offset,record] of records.slice(this.page*12,(this.page+1)*12).entries()){
      const button=document.createElement('button');button.className='event';const preview=document.createElement('span');preview.className='preview';preview.textContent=this.text.noThumb;
      const meta=document.createElement('span');meta.className='meta';const name=document.createElement('span');name.className='camera-name';name.textContent=this.name(record.entity_id);const time=document.createElement('span');time.className='event-time';time.textContent=`▶ ${record.start.slice(11)} – ${record.end.slice(11)}`;meta.append(name,time);button.append(preview,meta);button.onclick=()=>this.play(this.page*12+offset);root.append(button);pending.push({record,preview});
    }
    for(const {record,preview} of pending){
      signal.throwIfAborted();if(!record.thumbnail)continue;
      try{let url=this.urls.get(record.id);if(!url){const response=await this.fetch(`/api/eufy_viewer/recordings/${record.entity_id}/${record.id}/thumbnail`,signal);if(!response.headers.get('content-type')?.startsWith('image/jpeg'))continue;const blob=await response.blob();signal.throwIfAborted();if(!blob.size||blob.size>2*1024*1024)continue;url=URL.createObjectURL(blob);this.urls.set(record.id,url);while(this.urls.size>24){const first=this.urls.keys().next().value!;URL.revokeObjectURL(this.urls.get(first)!);this.urls.delete(first);}}
        const image=document.createElement('img');image.alt='';image.src=url;preview.replaceChildren(image);
      }catch(error){if(signal.aborted)throw error;}
    }
  }
  private play(index:number) {
    const records=this.filtered(),record=records[index];if(!record || !this.cameras().includes(record.entity_id))return;this.selected=index;
    const dialog=this.q<HTMLDialogElement>('dialog');if(!dialog.open)dialog.showModal();
    this.q('.player-title').textContent=`${this.name(record.entity_id)} · ${record.start.replace('T',' ')}`;
    this.q<HTMLButtonElement>('.previous').disabled=index<=0;this.q<HTMLButtonElement>('.next').disabled=index>=records.length-1;
    this.run(async signal=>{
      this.q('.player-status').textContent=this.text.preparing;
      try {
        await this.playback.play(this.ha!,record.entity_id,record.id,this.q<HTMLVideoElement>('video'),signal,(state,error)=>{
          if(signal.aborted)return;
          this.active=state==='preparing';
          if(state==='failed'){this.clearVideo();this.q('.player-status').textContent=this.failure(error);}
          else this.q('.player-status').textContent=state==='preparing'?this.text.preparing:'';
        });
        this.q('.player-status').textContent='';
      } catch(error) { if(!signal.aborted)this.clearVideo(); throw error; }
    });
  }
}
customElements.define('eufy-events-card',EufyEventsCard);
(window as unknown as {customCards:unknown[]}).customCards=(window as unknown as {customCards:unknown[]}).customCards||[];
(window as unknown as {customCards:unknown[]}).customCards.push({type:'eufy-events-card',name:'Eufy Events',description:'Existing HomeBase recordings in one timeline.',preview:true});
