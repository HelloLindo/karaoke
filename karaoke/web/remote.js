// A display owns its playback and opts in. A remote only asks; it never plays,
// and a command that is late, repeated or meant for another song does nothing.
const NEEDS_SOUND = new Set(['play','restart','next','seek']);

export class RemoteDisplay {
  // send(path, body) posts; host exposes the live performance of this tab.
  constructor(id, send, host, clockOffset = () => 0) {
    Object.assign(this, {id, send, host, clockOffset, seq:0, failures:0, results:[], done:new Map(), queue:Promise.resolve()});
  }
  start(session) {
    if (this.session === session) return;
    // seq keeps rising: the server may still hold this session's last report.
    this.session = session; this.results = []; this.done.clear();
    this.last = null; this.retrying(0);
  }
  stop() { this.start(null); }
  // The server forgot or never had this state: a new connection starts over.
  resync() { this.last = null; this.retrying(0); this.report(); }
  retrying(failures) {
    clearTimeout(this.timer);
    this.failures = failures;
    this.timer = failures ? setTimeout(() => { this.timer = null; this.report(); }, Math.min(30000, 500 * 2 ** failures)) : null;
  }
  report() {
    if (!this.session || this.sending || this.timer) return;
    // Compare on this device's clock: every room update refines the offset by
    // a few milliseconds, which is not a change in playback.
    const state = this.host.state(), signature = JSON.stringify(state);
    if (signature === this.last && !this.results.length) return;
    const {session} = this, results = this.results.splice(0, 32);
    this.last = signature;
    if (state.started_at != null) state.started_at += this.clockOffset();
    this.sending = true;
    this.send(`/v1/remote/displays/${encodeURIComponent(this.id)}/state`, {...state, session, seq:this.seq++, results})
      .then(() => { this.failures = 0; }, () => {
        if (this.session !== session) return;
        // Playback calls report() on every tick, so a failure must hold them
        // off. Reopening the event stream resyncs without waiting.
        this.results.unshift(...results); this.last = null;
        this.retrying(this.failures + 1);
      })
      .then(() => { this.sending = false; this.report(); });
  }
  receive(command) {
    const {session} = this;
    if (!session || command.session !== session) return this.queue;
    // Serialise: each command is judged against the song the previous one left.
    return this.queue = this.queue.then(async () => {
      if (this.session !== session) return;
      const status = this.done.get(command.command_id) || await this.execute(command);
      if (this.session !== session) return;
      this.done.set(command.command_id, status);
      if (this.done.size > 64) this.done.delete(this.done.keys().next().value);
      this.results.push({command_id:command.command_id, status});
      this.report();
    });
  }
  async execute({action, entry_id = null, expires_at, position, level, pitch_semitones}) {
    if (Date.now()/1000 + this.clockOffset() > expires_at) return 'expired';
    if (action !== 'lead' && entry_id !== this.host.entry()) return 'stale';
    if (NEEDS_SOUND.has(action) && this.host.locked()) return 'locked';
    if (action === 'pitch' && this.host.pitchUnavailable()) return 'unavailable';
    const extra = {entry_id, position, level, pitch_semitones};
    try { return await this.host.run(action, extra) ? 'applied' : 'failed'; }
    catch { return 'failed'; }
  }
}

export const REMOTE_ERRORS = {locked:'请先在播放屏上点一次播放', stale:'播放屏已经换到另一首歌', expired:'操作太迟了，请再试一次',
  unavailable:'播放屏暂时不能升降调', failed:'播放屏没能完成操作', timeout:'播放屏没有响应'};
const PLAYING = new Set(['playing','loading','waiting']);

// Presents the chosen display with LocalPlayback's shape, so the existing
// controls render it. It has no saved state and nothing to finish.
export class RemoteControl {
  constructor({send, changed, chosen = null, choose = () => {}, clockOffset = () => 0, newId = () => `${Date.now()}-${Math.random()}`, wait = 3000}) {
    Object.assign(this, {send, changed, chosen, choose, clockOffset, newId, wait, displays:[], pending:new Map(), pendingFinishes:[]});
    this.entry = null; this.state = this.view(null);
  }
  get display() { return this.displays.find(display => display.id === this.chosen) || null; }
  get phase() { return this.display?.state.phase || (this.chosen || this.displays.length < 2 ? 'offline' : 'choose'); }
  receive({displays}) {
    this.displays = displays;
    // Only the first display is picked automatically. Once chosen, a missing
    // display stays missing rather than quietly controlling another room.
    if (!this.chosen && displays.length === 1) this.select(displays[0].id);
    for (const {results} of displays) for (const {command_id, status} of results)
      this.settle(command_id, status);
    this.changed();
  }
  select(id) {
    if (id === this.chosen) return;
    this.chosen = id; this.choose(id);
    for (const command of [...this.pending.keys()]) this.settle(command, 'stale');
  }
  settle(id, status) {
    const command = this.pending.get(id);
    if (!command) return;
    clearTimeout(command.timer);
    this.pending.delete(id);
    command.resolve(status);
  }
  view(state) {
    return {playing:PLAYING.has(state?.phase), position:state?.position || 0,
      started_at:state?.started_at == null ? null : state.started_at - this.clockOffset(),
      levels:{instrumental:1, backing_vocals:1, lead_vocals:state?.lead || 0}, pitch_semitones:state?.pitch || 0};
  }
  reconcile(room) {
    const state = this.display?.state;
    this.state = this.view(state);
    for (const {patch} of this.pending.values()) Object.assign(this.state, patch);
    const queued = state?.entry_id && room.entries.find(entry => entry.id === state.entry_id);
    const known = queued || (state?.job_id && room.library?.find(song => song.job_id === state.job_id));
    this.entry = !state?.entry_id ? null : known ? {...known, id:state.entry_id} :
      {id:state.entry_id, job_id:state.job_id, title:'正在播放的歌', artist:'', status:'completed', duration:0};
    return {...room, ...this.state, current_id:this.entry?.id || null};
  }
  position() {
    const {position, playing, started_at} = this.state;
    return position + (playing && started_at !== null ? Math.max(0, Date.now()/1000 - started_at) : 0);
  }
  introSkipTarget() {
    const state = this.display?.state, position = this.position();
    return state?.phase === 'playing' && state.intro_start != null && position < state.intro_start ? state.intro_start : null;
  }
  isFinished() { return false; }
  save() { return {}; }
  // Resolves with the display's own answer. Until then the control shows the
  // requested value, and a missing answer puts the real one back.
  async command(action, extra = {}) {
    const display = this.display;
    if (!display) return 'offline';
    if (action === 'toggle_lead') {
      action = 'lead';
      extra = {level:this.state.levels.lead_vocals > 0 ? 0 : display.state.lead_restore || 1};
    }
    const id = this.newId(), started = this.state.started_at === null ? null : Date.now()/1000;
    const patch = {lead:{levels:{...this.state.levels, lead_vocals:Math.max(0, Math.min(1, extra.level))}},
      pitch:{pitch_semitones:extra.pitch_semitones}, seek:{position:extra.position, started_at:started},
      pause:{position:this.position(), playing:false, started_at:null}}[action] || {};
    const body = {command_id:id, session:display.session, action};
    if (this.entry) body.entry_id = extra.entry_id || this.entry.id;
    if (action === 'lead') body.level = patch.levels.lead_vocals;
    if (action === 'pitch') body.pitch_semitones = extra.pitch_semitones;
    if (action === 'seek') body.position = extra.position;
    const answer = new Promise(resolve => {
      this.pending.set(id, {patch, resolve, timer:setTimeout(() => this.settle(id, 'timeout'), this.wait)});
    });
    this.changed();
    try { await this.send(`/v1/remote/displays/${encodeURIComponent(display.id)}/commands`, body); }
    catch (error) { this.settle(id, error.message); }
    const status = await answer;
    this.changed();
    return status;
  }
}
