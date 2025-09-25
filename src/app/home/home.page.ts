import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

// Ionic standalone components
import {
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonButton,
  IonInput,
  IonText,
  IonIcon
} from '@ionic/angular/standalone'

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonButton,
    IonInput,
    IonText,
    IonIcon
  ],
})
export class HomePage implements OnInit {
  // ---- WS state ----
  private ws?: WebSocket;
  connected = false;
  private manualClose = false;
  private retries = 0;
  private ka?: any; // keep-alive timer

  // agent readiness (to gate mic)
  agentReady = false;

  // ping → "Listening…" UX
  private lastPing?: number;
  private lastListeningLog?: number;

  // ---- UI ----
  logs: string[] = [];
  textMsg = 'Hello from Ionic!';

  // ---- Mic / WebAudio ----
  private audioCtx?: AudioContext;
  private srcNode?: MediaStreamAudioSourceNode;
  private procNode?: ScriptProcessorNode;
  private mediaStream?: MediaStream;
  private inSampleRate = 48000;
  micOn = false;
  private floatBuf: number[] = [];

  // mic permission flags
  micPermRequested = false;
  micPermGranted = false;

  // ---- Output audio (playback) ----
  private outCtx?: AudioContext;
  private outPlayhead = 0;
  // ---- Mic desire flag (auto start on WS open/reopen)
  private wantMic = true;  // auto-start mic when websocket is up


  // ---- Config ----
  private wsUrl(): string {
    // NOTE: HTTPS पर deploy करने पर WSS उपयोग करें
    return 'wss://elevanagents.onrender.com/ws/app?id=webtest1';
    // return 'wss://your-domain/ws/app?id=webtest1';
  }

  speaking = false; // agent बोल रहा हो तो true

  // ===================== INIT: ask mic permission =====================
  async ngOnInit() {
    await this.preRequestMicPermission();
  }

  private async preRequestMicPermission() {
    if (!navigator?.mediaDevices?.getUserMedia) {
      this.append('⚠️ Mic API not available in this browser');
      return;
    }
    try {
      this.micPermRequested = true;
      // Prompt for mic access on page load, then immediately stop stream.
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(t => t.stop());
      this.micPermGranted = true;
      this.append('✅ Mic permission granted (prefetched)');
    } catch (e: any) {
      this.micPermGranted = false;
      this.append(`🚫 Mic permission denied: ${e?.message ?? e}`);
    }
  }

  // ===================== Connect / Retry =====================
  async connect() {
    if (this.connected) return;
    this.manualClose = false;

    this.wantMic = true;

    const url = this.wsUrl();
    this.append(`Connecting → ${url}`);

    try {
      await this.ensureOutCtx();

      // ✅ START button ke gesture par mic permission lo
      if (!this.micPermGranted) {
        await this.ensureMicPermissionUserGesture();
      }

      this.ws = new WebSocket(url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.addEventListener('open', () => {
        this.connected = true;
        this.retries = 0;
        this.agentReady = false;
        this.append('✅ WS OPEN');
        this.startKA();

        // WS खुलते ही mic on करने की कोशिश
        if (this.wantMic && !this.micOn) this.startMic();


        this.sendJson({
          type: 'conversation_initiation_client_data',
          conversation_initiation_client_data: {
            conversation_config_override: { conversation: { text_only: false } },
          },
        });
      });

      this.ws.addEventListener('message', (evt) => this.onMessage(evt));
      this.ws.addEventListener('close', (e) => {
        this.append(`❌ WS CLOSE (${e.code})`);
        this.stopKA();
        this.stopMic(false);
        this.connected = false; this.agentReady = false;
        this.ws = undefined;
        if (!this.manualClose) this.scheduleReconnect();
      });
      this.ws.addEventListener('error', () => {
        this.append('❌ WS ERROR');
        this.stopKA();
        this.stopMic(false);
        this.connected = false; this.agentReady = false;
        this.ws = undefined;
        if (!this.manualClose) this.scheduleReconnect();
      });
    } catch (e: any) {
      this.append(`❌ connect error: ${e?.message ?? e}`);
      this.stopKA();
      if (!this.manualClose) this.scheduleReconnect();
    }
  }

  private onMessage(evt: MessageEvent) {
    const data = evt.data;
    if (data instanceof ArrayBuffer) {
      this.schedulePcmPlayback(new Uint8Array(data));
      this.append(`🔊 raw chunk ${data.byteLength} bytes`);
      return;
    }
    try {
      const j = JSON.parse(data as string);

      if (j.type === 'agent_ready') {
        this.agentReady = true;
        this.append('✅ agent_ready');
        if (this.wantMic && !this.micOn && this.micPermGranted) this.startMic();
        return;
      }

      if (j.type === 'ping' || j.ping_event) {
        const now = Date.now();
        this.lastPing = now;
        if (!this.lastListeningLog || now - this.lastListeningLog > 5000) {
          this.append('🎧 listening…');
          this.lastListeningLog = now;
        }
        return;
      }

      if (j.type === 'agent_response') {
        this.append(`🤖 ${j?.agent_response_event?.agent_response}`);
        return;
      }

      if (j.type === 'user_transcript') {
        this.append(`👤 ${j?.user_transcription_event?.user_transcript}`);
        return;
      }

      if (j.type === 'audio') {
        const b64: string | undefined = j?.audio_event?.audio_base_64;
        if (b64 && b64.length) {
          const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); // PCM16LE @ 16k
          this.schedulePcmPlayback(bytes, 16000);
          this.append(`🔊 chunk ${bytes.length} bytes (scheduled)`);
        }
        return;
      }

      const s = String(data);
      this.append(`📩 ${s.slice(0, 200)}...`);
    } catch {
      this.append(`RAW: ${data}`);
    }
  }

  private startKA() {
    this.stopKA();
    this.ka = setInterval(() => {
      if (this.connected) {
        this.sendJson({ type: 'client_keepalive', ts: new Date().toISOString() });
      }
    }, 20000);
  }
  private stopKA() { if (this.ka) clearInterval(this.ka); this.ka = undefined; }

  private scheduleReconnect() {
    const seconds = Math.min(32, 2 << this.retries); // 2,4,8,16,32
    this.retries = Math.min(5, this.retries + 1);
    this.append(`⏳ reconnect in ${seconds} s`);
    setTimeout(() => { if (!this.connected && !this.manualClose) this.connect(); }, seconds * 1000);
  }

  // ===================== Send helpers =====================
  private sendJson(m: any) {
    if (!this.ws || !this.connected) return;
    this.ws.send(JSON.stringify(m));
  }

  sendText() {
    if (!this.connected) return;
    const t = this.textMsg.trim();
    if (!t) return;
    this.sendJson({ type: 'user_message', text: t, expect_audio: true });
    this.append(`➡️ sent: "${t}"`);
  }

  disconnect() {
    this.manualClose = true;
    this.stopKA();
    this.stopMic(false);
    this.wantMic = false;
    this.ws?.close(1000, 'manual');
    this.connected = false;
    this.append('🔒 manually closed');
  }

  // ===================== MIC STREAMING =====================
  async startMic() {
    if (!this.connected || this.micOn) return;
    try {
      // even if we pre-fetched permission, take a FRESH stream for processing
      const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.mediaStream = ms;

      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.audioCtx = ctx;
      this.inSampleRate = Math.round(ctx.sampleRate);
      this.append(`🎙️ Mic ON (inRate=${this.inSampleRate})`);

      const src = ctx.createMediaStreamSource(ms);
      this.srcNode = src;

      const proc = ctx.createScriptProcessor(4096, 1, 1);
      this.procNode = proc;

      proc.addEventListener('audioprocess', (event: AudioProcessingEvent) => {
        const input = event.inputBuffer.getChannelData(0);
        // accumulate ~100ms
        this.floatBuf.push(...input);
        const frameSamplesIn = Math.round(0.1 * this.inSampleRate);
        while (this.floatBuf.length >= frameSamplesIn) {
          const chunk = this.floatBuf.splice(0, frameSamplesIn);
          const resampled = this.resampleTo16k(new Float32Array(chunk), this.inSampleRate);
          const pcm = this.f32ToPcm16(resampled);
          this.sendBinary(pcm);
        }
      });

      proc.connect(ctx.destination); // keeps processor alive
      src.connect(proc);

      this.micOn = true;
    } catch (e: any) {
      this.append(`❌ mic error: ${e?.message ?? e}`);
      this.stopMic(false);
    }
  }

  stopMic(sendAudioEnd: boolean) {
    try { this.procNode?.disconnect(); } catch { }
    this.procNode = undefined;
    try { this.srcNode?.disconnect(); } catch { }
    this.srcNode = undefined;
    try { this.audioCtx?.close(); } catch { }
    this.audioCtx = undefined;
    if (this.mediaStream) {
      try { this.mediaStream.getTracks().forEach(t => t.stop()); } catch { }
    }
    this.mediaStream = undefined;
    this.floatBuf.length = 0;

    if (sendAudioEnd && this.connected) {
      this.sendJson({ type: 'user_audio_end' });
      this.append('🛑 sent user_audio_end');

      // 👇 user ने जानबूझकर बंद किया, दोबारा auto-start न करें
      this.wantMic = false;
    }
    if (this.micOn) this.micOn = false;
  }

  private sendBinary(bytes: Uint8Array) {
    if (!this.ws || !this.connected) return;
    try { this.ws.send(bytes); } catch { }
  }

  // ===================== RESAMPLE / PCM =====================
  private resampleTo16k(input: Float32Array, inRate: number): Float32Array {
    if (inRate === 16000) return input;
    const ratio = inRate / 16000;
    const n = Math.floor(input.length / ratio);
    const out = new Float32Array(n);
    let pos = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const s0 = input[idx];
      const s1 = idx + 1 < input.length ? input[idx + 1] : s0;
      out[i] = s0 + (s1 - s0) * frac;
      pos += ratio;
    }
    return out;
  }
  private f32ToPcm16(f: Float32Array): Uint8Array {
    const out = new Uint8Array(f.length * 2);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < f.length; i++) {
      let s = Math.max(-1, Math.min(1, f[i]));
      dv.setInt16(i * 2, Math.round(s * 32767), true);
    }
    return out;
  }

  // ===================== PLAYBACK (PCM16k) =====================
  private async ensureOutCtx() {
    if (this.outCtx) return;
    this.outCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    try { await this.outCtx.resume(); } catch { }
  }

  private schedulePcmPlayback(pcm16le: Uint8Array, sampleRate = 16000) {
    if (!this.outCtx) return;

    const samples = Math.floor(pcm16le.length / 2);
    const f32 = new Float32Array(samples);
    const dv = new DataView(pcm16le.buffer, pcm16le.byteOffset, pcm16le.byteLength);
    for (let i = 0; i < samples; i++) {
      const s = dv.getInt16(i * 2, true);
      f32[i] = Math.max(-1, Math.min(1, s / 32768));
    }

    const buf = this.outCtx.createBuffer(1, samples, sampleRate);
    buf.copyToChannel(f32, 0, 0);

    const src = this.outCtx.createBufferSource();
    src.buffer = buf;
    src.connect(this.outCtx.destination);

    const now = this.outCtx.currentTime;
    if (this.outPlayhead < now) this.outPlayhead = now;
    src.start(this.outPlayhead);
    this.outPlayhead += samples / sampleRate;
  }

  // ===================== UI helpers =====================
  statusText(): string {
    if (!this.connected) return 'Status: Not connected';
    const listening = this.lastPing && (Date.now() - this.lastPing) < 5000;
    return 'Status: ' + (this.micOn ? 'Streaming mic' : (listening ? 'Listening…' : 'Connected'));
  }
  private append(line: string) {
    const ts = new Date().toISOString().split('T')[1]!.split('.')[0];
    this.logs.unshift(`[${ts}] ${line}`);
    console.log(line);
    console.log(this.logs);
  }

  // ---- cleanup ----
  ngOnDestroy(): void {
    this.disconnect();
  }

  private async ensureMicPermissionUserGesture() {
    // HTTPS check (localhost allowed)
    if (!window.isSecureContext && location.hostname !== 'localhost') {
      console.log('❌ HTTPS required for mic (or use localhost)');
      throw new Error('Mic needs HTTPS or localhost');
    }
    if (!navigator?.mediaDevices?.getUserMedia) {
      console.log('❌ Mic API not available');
      throw new Error('Mic API not available');
    }
    try {
      // Prompt user; then close immediately. This only grabs permission.
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(t => t.stop());
      this.micPermRequested = true;
      this.micPermGranted = true;
      console.log('✅ Mic permission granted (on START)');
    } catch (e: any) {
      this.micPermRequested = true;
      this.micPermGranted = false;
      console.log('🚫 Mic permission denied:', e?.message ?? e);
      throw e;
    }
  }

}
