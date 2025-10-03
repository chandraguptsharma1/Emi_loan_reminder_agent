import { Component, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonHeader, IonToolbar, IonTitle, IonContent,
  IonButton, IonSpinner, IonIcon, IonText
} from '@ionic/angular/standalone';

@Component({
  selector: 'app-voice',
  templateUrl: './voice.page.html',
  styleUrls: ['./voice.page.scss'],
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    IonHeader, IonToolbar, IonTitle, IonContent,
    IonButton, IonSpinner, IonIcon, IonText
  ],
})
export class VoicePage implements OnDestroy {
  private API_BASE = 'http://localhost:3000';

  connected = false;
  micOn = false;
  playing = false;
  sid = '';
  rec?: MediaRecorder;
  mediaStream?: MediaStream;
  speaking = false;  // UI ke liye


  // ---- Loader + Message system ----
  loading = false;
  uiMsg = '';
  uiMsgType: 'info' | 'success' | 'error' = 'info';

  uiMsgIcon() {
    return this.uiMsgType === 'error' ? 'alert-circle'
      : this.uiMsgType === 'success' ? 'checkmark-circle' : 'information-circle';
  }
  clearUiMsg() { this.uiMsg = ''; }
  private info(m: string) { this.uiMsg = m; this.uiMsgType = 'info'; }
  private ok(m: string) { this.uiMsg = m; this.uiMsgType = 'success'; }
  private err(m: string) { this.uiMsg = m; this.uiMsgType = 'error'; console.error(m); }

  // ================== PUBLIC ==================
  async connect() {
    if (this.connected || this.loading) return;
    this.loading = true; this.clearUiMsg();

    try {
      // 1) Start session
      const resp = await fetch(`${this.API_BASE}/api/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ due_amount: 12345, lang: 'hi-IN' })
      });
      if (!resp.ok) throw new Error(`session/start failed: ${resp.status}`);
      const { session_id } = await resp.json();
      this.sid = session_id;

      // 2) Kickoff Monica greeting
      const kick = await fetch(`${this.API_BASE}/api/voice-kickoff?session_id=${this.sid}`);
      if (kick.ok) {
        const arr = await kick.arrayBuffer();
        await this.playWav(arr);
      }

      // 3) Mic setup
      await this.prepareMic();
      this.connected = true;
      this.ok('Listening… speak now');
      this.startRecording();

    } catch (e: any) {
      this.err('Connect error: ' + (e?.message || e));
      this.stopEverything();
    } finally {
      this.loading = false;
    }
  }

  async disconnect() {
    this.connected = false;
    this.micOn = false;
    try { this.rec?.stop(); } catch { }
    try { this.mediaStream?.getTracks().forEach(t => t.stop()); } catch { }

    if (this.sid) {
      await fetch(`${this.API_BASE}/api/session/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: this.sid })
      }).catch(() => { });
      this.sid = '';
    }
    this.info('Disconnected.');
  }

  ngOnDestroy() { this.disconnect(); }

  // ================== MIC ==================
  private async prepareMic() {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }

  private startRecording() {
    if (!this.mediaStream) return;
    const mime = this.pickMime();
    this.rec = new MediaRecorder(this.mediaStream, mime ? { mimeType: mime } : undefined);

    const chunks: Blob[] = [];
    this.rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    this.rec.onstop = async () => {
      if (!this.connected) return;
      const blob = new Blob(chunks, { type: this.rec?.mimeType || 'audio/webm' });
      await this.sendToServer(blob);
    };

    this.rec.start();
    this.micOn = true;
    this.info('Listening…');

    setTimeout(() => {
      if (this.rec && this.rec.state !== 'inactive') {
        this.rec.stop();
        this.micOn = false;
      }
    }, 4000);
  }

  private async sendToServer(blob: Blob) {
    this.info('Processing…');

    const form = new FormData();
    form.append('file', blob, 'user.webm');
    form.append('session_id', this.sid);

    try {
      const resp = await fetch(`${this.API_BASE}/api/voice-chat`, { method: 'POST', body: form });

      if (resp.status === 204) {
        this.info('No response, retrying…');
        this.startRecording();
        return;
      }

      if (!resp.ok) {
        this.err('Server error ' + resp.status);
        this.startRecording();
        return;
      }

      const buf = await resp.arrayBuffer();
      this.info('Playing reply…');
      await this.playWav(buf);

      // 👇 yaha check karo
      if (resp.headers.get("X-Session-End") === "true") {
        await this.disconnect();
        this.uiMsg = "Call ended.";
        return;
      }

      if (this.connected) this.startRecording();
    } catch (e: any) {
      this.err('Send error: ' + (e?.message || e));
      if (this.connected) this.startRecording();
    }
  }

  // ================== AUDIO ==================
  private playWav(buf: ArrayBuffer) {
    return new Promise<void>((resolve) => {
      this.playing = true;
      this.speaking = true;   // 🔊 bolna start

      const blob = new Blob([buf], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);

      audio.onended = () => {
        this.playing = false;
        this.speaking = false;  // 🔊 bolna khatam
        URL.revokeObjectURL(url);
        resolve();
      };
      audio.onerror = () => {
        this.playing = false;
        this.speaking = false;  // 🔊 error me bhi reset
        URL.revokeObjectURL(url);
        resolve();
      };
      audio.play().catch(() => {
        this.playing = false;
        this.speaking = false;  // 🔊 agar play hi na ho
        URL.revokeObjectURL(url);
        resolve();
      });
    });
  }


  // ================== CLEANUP ==================
  private stopEverything() {
    this.connected = false;
    this.micOn = false;
    this.playing = false;
    try { this.rec?.stop(); } catch { }
    try { this.mediaStream?.getTracks().forEach(t => t.stop()); } catch { }
    this.mediaStream = undefined;
    this.rec = undefined;
  }

  private pickMime(): string {
    const cands = [
      'audio/webm;codecs=opus',
      'audio/ogg;codecs=opus',
      'audio/mp4',
      'audio/webm'
    ];
    for (const c of cands) {
      if ((window as any).MediaRecorder?.isTypeSupported?.(c)) return c;
    }
    return '';
  }
}
