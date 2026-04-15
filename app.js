/**
 * Live Voice Changer Engine
 * Core Logic using Web Audio API
 */

class VoiceChanger {
    constructor() {
        this.audioCtx = null;
        this.micStream = null;
        this.micSourceNode = null;
        this.fileSourceNode = null;
        this.activeSource = null; // Either 'mic' or 'file'
        
        this.analyser = null;
        this.masterGain = null;
        this.currentEffectNode = null;
        
        // Internal state
        this.isPlaying = false;
        this.isRecording = false;
        this.mediaRecorder = null;
        this.recordedChunks = [];
        this.intensity = 0.5;
        this.effectName = 'normal';
        this.timerInterval = null;
        this.noiseReductionEnabled = false;
        this.noiseFilter = null;
        this.humFilter = null;
        
        // Active modulation sources for cleanup
        this.activeModules = [];

        this.initUIElements();
        this.attachListeners();
        this.setupVisualizer();
    }

    initUIElements() {
        this.startBtn = document.getElementById('start-mic-btn');
        this.importBtn = document.getElementById('import-btn');
        this.fileInput = document.getElementById('audio-upload');
        this.playPauseBtn = document.getElementById('play-pause-btn');
        this.recordBtn = document.getElementById('record-btn');
        this.volumeSlider = document.getElementById('volume-slider');
        this.intensitySlider = document.getElementById('intensity-slider');
        this.effectBtns = document.querySelectorAll('.effect-btn');
        this.micStatus = document.getElementById('mic-status');
        this.currentEffectLabel = document.getElementById('current-effect-name');
        this.visualizerCanvas = document.getElementById('visualizer');
        this.noiseReduceBtn = document.getElementById('noise-reduce-btn');
        this.noiseReduceText = document.getElementById('noise-reduce-text');
        
        this.volumeText = document.getElementById('volume-val');
        this.intensityText = document.getElementById('intensity-val');
    }

    attachListeners() {
        this.startBtn.addEventListener('click', () => this.initMic());
        this.importBtn.addEventListener('click', () => this.fileInput.click());
        this.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));
        
        this.playPauseBtn.addEventListener('click', () => this.togglePlayback());
        this.recordBtn.addEventListener('click', () => this.toggleRecording());
        
        if (this.noiseReduceBtn) {
            this.noiseReduceBtn.addEventListener('click', () => {
                this.noiseReductionEnabled = !this.noiseReductionEnabled;
                this.noiseReduceText.innerText = `Noise Reduction: ${this.noiseReductionEnabled ? 'ON' : 'OFF'}`;
                this.noiseReduceBtn.style.color = this.noiseReductionEnabled ? 'var(--accent-primary)' : 'white';
                if (this.isPlaying) {
                    this.applyEffect(this.effectName);
                }
            });
        }

        
        this.volumeSlider.addEventListener('input', (e) => {
            const val = e.target.value;
            this.volumeText.innerText = `${val}%`;
            if (this.masterGain) {
                this.masterGain.gain.setTargetAtTime(val / 100, this.audioCtx.currentTime, 0.05);
            }
        });

        this.intensitySlider.addEventListener('input', (e) => {
            this.intensity = e.target.value / 100;
            this.intensityText.innerText = `${e.target.value}%`;
            if (this.isPlaying) {
                this.applyEffect(this.effectName);
            }
        });

        this.effectBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                this.effectBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.effectName = btn.dataset.effect;
                this.currentEffectLabel.innerText = `${btn.innerText} Mode`;
                if (this.isPlaying) this.applyEffect(this.effectName);
            });
        });
    }

    ensureAudioContext() {
        if (!this.audioCtx) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            this.audioCtx = new AudioContext({
                latencyHint: 'interactive',
                sampleRate: 44100
            });
            
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 256;
            
            this.masterGain = this.audioCtx.createGain();
            this.masterGain.gain.value = this.volumeSlider.value / 100;

            this.drawVisualizer();
        }
        return this.audioCtx.state === 'suspended' ? this.audioCtx.resume() : Promise.resolve();
    }

    async initMic() {
        await this.ensureAudioContext();
        try {
            if (this.micStream) {
                // Already have mic, just switch to it
                this.activeSource = 'mic';
                this.togglePlayback();
                return;
            }

            const stream = await navigator.mediaDevices.getUserMedia({ 
                audio: { echoCancellation: false, noiseSuppression: false } 
            });
            
            this.micStream = stream;
            this.micSourceNode = this.audioCtx.createMediaStreamSource(stream);
            this.activeSource = 'mic';

            this.micStatus.classList.add('allowed');
            this.micStatus.querySelector('.status-text').innerText = 'Microphone Active';
            
            this.playPauseBtn.disabled = false;
            this.recordBtn.disabled = false;
            
            this.isPlaying = false; // Reset to ensure toggle works
            this.togglePlayback();

        } catch (err) {
            console.error('Mic access denied:', err);
            alert('Could not access microphone.');
        }
    }

    async handleFileSelect(event) {
        const file = event.target.files[0];
        if (!file) return;

        await this.ensureAudioContext();
        
        const reader = new FileReader();
        reader.onload = async (e) => {
            const buffer = await this.audioCtx.decodeAudioData(e.target.result);
            this.loadedAudioBuffer = buffer;
            this.activeSource = 'file';
            
            this.micStatus.classList.add('allowed');
            this.micStatus.querySelector('.status-text').innerText = `File: ${file.name.substring(0, 15)}...`;
            
            this.playPauseBtn.disabled = false;
            this.recordBtn.disabled = false;

            if (this.isPlaying) this.togglePlayback(); // Stop current
            this.togglePlayback(); // Start new
        };
        reader.readAsArrayBuffer(file);
    }

    togglePlayback() {
        if (!this.isPlaying) {
            this.isPlaying = true;
            this.playPauseBtn.innerHTML = '<span class="icon">⏸️</span>';
            this.applyEffect(this.effectName);
        } else {
            this.isPlaying = false;
            this.playPauseBtn.innerHTML = '<span class="icon">▶️</span>';
            this.disconnectAll();
            
            // If it was a file source, we need to stop the buffer
            if (this.fileSourceNode) {
                try { this.fileSourceNode.stop(); } catch(e) {}
                this.fileSourceNode = null;
            }
        }
    }

    disconnectAll() {
        if (this.micSourceNode) this.micSourceNode.disconnect();
        if (this.fileSourceNode) {
            try { this.fileSourceNode.stop(); } catch(e) {}
            this.fileSourceNode.disconnect();
            this.fileSourceNode = null;
        }
        
        if (this.currentEffectNode) {
            this.currentEffectNode.input.disconnect();
            this.currentEffectNode.output.disconnect();
        }

        if (this.noiseFilter) {
            try { this.noiseFilter.disconnect(); } catch(e) {}
            this.noiseFilter = null;
        }
        if (this.humFilter) {
            try { this.humFilter.disconnect(); } catch(e) {}
            this.humFilter = null;
        }

        this.activeModules.forEach(mod => {
            try { mod.stop(); } catch(e) {}
            mod.disconnect();
        });
        this.activeModules = [];

        if (this.analyser) this.analyser.disconnect();
        if (this.masterGain) this.masterGain.disconnect();
    }

    applyEffect(name) {
        if (!this.isPlaying) return;
        
        this.disconnectAll();
        
        const effect = this.createEffectNode(name);
        this.currentEffectNode = effect;

        let source;
        if (this.activeSource === 'mic') {
            source = this.micSourceNode;
        } else if (this.activeSource === 'file') {
            this.fileSourceNode = this.audioCtx.createBufferSource();
            this.fileSourceNode.buffer = this.loadedAudioBuffer;
            this.fileSourceNode.loop = true;
            this.fileSourceNode.start(0);
            source = this.fileSourceNode;
        }

        if (!source) return;

        let nodeToProcess = source;

        if (this.noiseReductionEnabled) {
            // Apply a simple noise gate/reduction using compressor and highpass
            this.noiseFilter = this.audioCtx.createDynamicsCompressor();
            this.noiseFilter.threshold.value = -50;
            this.noiseFilter.knee.value = 40;
            this.noiseFilter.ratio.value = 12;
            this.noiseFilter.attack.value = 0;
            this.noiseFilter.release.value = 0.25;

            this.humFilter = this.audioCtx.createBiquadFilter();
            this.humFilter.type = 'highpass';
            this.humFilter.frequency.value = 80;

            source.connect(this.humFilter);
            this.humFilter.connect(this.noiseFilter);
            nodeToProcess = this.noiseFilter;
        }

        nodeToProcess.connect(effect.input);
        effect.output.connect(this.analyser);
        this.analyser.connect(this.masterGain);
        this.masterGain.connect(this.audioCtx.destination);
    }

    /**
     * Effect Processing Engine
     */
    createEffectNode(name) {
        const input = this.audioCtx.createGain();
        const output = this.audioCtx.createGain();
        
        switch(name) {
            case 'robot': {
                // Ring Modulation: Gain modulated by a fast sine oscillator
                const osc = this.audioCtx.createOscillator();
                const mod = this.audioCtx.createGain();
                osc.type = 'sine';
                osc.frequency.value = 50 + (this.intensity * 80);
                osc.connect(mod.gain);
                input.connect(mod);
                mod.connect(output);
                osc.start();
                this.activeModules.push(osc);
                break;
            }

            case 'deep': {
                // Simulated Deep Voice: Lowpass + 15ms constant delay for slight phasing
                const lp = this.audioCtx.createBiquadFilter();
                lp.type = 'lowpass';
                lp.frequency.value = 400 + (1 - this.intensity) * 600;
                lp.Q.value = 5;
                const dist = this.audioCtx.createWaveShaper();
                dist.curve = this.makeDistortionCurve(50);
                input.connect(lp);
                lp.connect(dist);
                dist.connect(output);
                break;
            }

            case 'chipmunk': {
                // Simulated High Pitch: Highpass + high shelf boost
                const hp = this.audioCtx.createBiquadFilter();
                hp.type = 'highpass';
                hp.frequency.value = 800 + (this.intensity * 1200);
                const shelf = this.audioCtx.createBiquadFilter();
                shelf.type = 'highshelf';
                shelf.frequency.value = 2000;
                shelf.gain.value = 10;
                input.connect(hp);
                hp.connect(shelf);
                shelf.connect(output);
                break;
            }

            case 'echo': {
                const delay = this.audioCtx.createDelay(5.0);
                const feedback = this.audioCtx.createGain();
                delay.delayTime.value = 0.2 + (this.intensity * 0.8);
                feedback.gain.value = 0.4 + (this.intensity * 0.4);
                
                input.connect(output); // Dry
                input.connect(delay); // Wet
                delay.connect(feedback);
                feedback.connect(delay); // Loop
                delay.connect(output);
                break;
            }

            case 'reverb': {
                // Use a chain of small delays to simulate room reflections
                const revGain = this.audioCtx.createGain();
                revGain.gain.value = 0.3 + (this.intensity * 0.5);
                const d1 = this.audioCtx.createDelay(); d1.delayTime.value = 0.015;
                const d2 = this.audioCtx.createDelay(); d2.delayTime.value = 0.025;
                const d3 = this.audioCtx.createDelay(); d3.delayTime.value = 0.045;
                
                input.connect(output); // Dry
                input.connect(d1); d1.connect(d2); d2.connect(d3); d3.connect(revGain);
                revGain.connect(output);
                break;
            }

            case 'alien': {
                // Vibrato modulation
                const lfo = this.audioCtx.createOscillator();
                const lfoGain = this.audioCtx.createGain();
                lfo.type = 'sawtooth';
                lfo.frequency.value = 15 + (this.intensity * 30);
                lfo.connect(lfoGain.gain);
                input.connect(lfoGain);
                lfoGain.connect(output);
                lfo.start();
                this.activeModules.push(lfo);
                break;
            }

            case 'telephone': {
                // Narrow bandpass for tinny sound
                const band = this.audioCtx.createBiquadFilter();
                band.type = 'bandpass';
                band.frequency.value = 1000;
                band.Q.value = 2 + (this.intensity * 5);
                input.connect(band);
                band.connect(output);
                break;
            }

            case 'monster': {
                // Heavy distortion + Bass boost
                const distortion = this.audioCtx.createWaveShaper();
                distortion.curve = this.makeDistortionCurve(100 + (this.intensity * 400));
                const bass = this.audioCtx.createBiquadFilter();
                bass.type = 'lowshelf';
                bass.frequency.value = 150;
                bass.gain.value = 20;
                input.connect(distortion);
                distortion.connect(bass);
                bass.connect(output);
                break;
            }

            case 'cave': {
                // Long feedback delay with lowpass
                const longDelay = this.audioCtx.createDelay(5.0);
                const fb = this.audioCtx.createGain();
                const lpCave = this.audioCtx.createBiquadFilter();
                longDelay.delayTime.value = 0.6;
                fb.gain.value = 0.5 + (this.intensity * 0.4);
                lpCave.frequency.value = 1200;
                
                input.connect(output);
                input.connect(longDelay);
                longDelay.connect(lpCave);
                lpCave.connect(fb);
                fb.connect(longDelay);
                longDelay.connect(output);
                break;
            }

            case 'radio': {
                // Band limit + Noise + Moderate distortion
                const filterRadio = this.audioCtx.createBiquadFilter();
                filterRadio.type = 'bandpass';
                filterRadio.frequency.value = 1200;
                const dRadio = this.audioCtx.createWaveShaper();
                dRadio.curve = this.makeDistortionCurve(80);
                input.connect(dRadio);
                dRadio.connect(filterRadio);
                filterRadio.connect(output);
                break;
            }

            default: // normal
                input.connect(output);
        }

        return { input, output };
    }

    makeDistortionCurve(amount) {
        const k = typeof amount === 'number' ? amount : 50;
        const n_samples = 44100;
        const curve = new Float32Array(n_samples);
        const deg = Math.PI / 180;
        for (let i = 0 ; i < n_samples; ++i ) {
            const x = i * 2 / n_samples - 1;
            curve[i] = ( 3 + k ) * x * 20 * deg / ( Math.PI + k * Math.abs(x) );
        }
        return curve;
    }

    setupVisualizer() {
        this.ctx = this.visualizerCanvas.getContext('2d');
        const resize = () => {
            this.visualizerCanvas.width = this.visualizerCanvas.clientWidth;
            this.visualizerCanvas.height = this.visualizerCanvas.clientHeight;
        };
        window.addEventListener('resize', resize);
        resize();
    }

    drawVisualizer() {
        if (!this.analyser) return;
        requestAnimationFrame(() => this.drawVisualizer());

        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        this.analyser.getByteFrequencyData(dataArray);

        const width = this.visualizerCanvas.width;
        const height = this.visualizerCanvas.height;
        this.ctx.clearRect(0, 0, width, height);

        const barWidth = (width / bufferLength) * 2;
        let x = 0;

        for(let i = 0; i < bufferLength; i++) {
            const barHeight = (dataArray[i] / 255) * height;
            
            // Neon gradient bars
            const grad = this.ctx.createLinearGradient(0, height, 0, height - barHeight);
            grad.addColorStop(0, '#00d2ff');
            grad.addColorStop(1, '#3a7bd5');

            this.ctx.fillStyle = grad;
            this.ctx.fillRect(x, height - barHeight, barWidth - 1, barHeight);
            
            x += barWidth;
        }
    }

    /**
     * Recording Implementation
     */
    toggleRecording() {
        if (!this.isRecording) {
            this.startRecording();
        } else {
            this.stopRecording();
        }
    }

    startRecording() {
        if (!this.audioCtx) return;
        this.recordedChunks = [];
        
        // Capture output from master gain
        const dest = this.audioCtx.createMediaStreamDestination();
        this.masterGain.connect(dest);
        
        this.mediaRecorder = new MediaRecorder(dest.stream, {
            mimeType: 'audio/webm;codecs=opus'
        });

        this.mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) this.recordedChunks.push(e.data);
        };

        this.mediaRecorder.onstop = () => this.downloadRecording();
        
        this.mediaRecorder.start();
        this.isRecording = true;
        this.recordBtn.classList.add('active');
        document.getElementById('recording-status').classList.remove('hidden');
        this.startTimer();
    }

    stopRecording() {
        if (this.mediaRecorder && this.isRecording) {
            this.mediaRecorder.stop();
            this.isRecording = false;
            this.recordBtn.classList.remove('active');
            document.getElementById('recording-status').classList.add('hidden');
            clearInterval(this.timerInterval);
            
            // Cleanup: disconnect the internal recorder bridge
            // Note: In a production app you'd manage this node reference, 
            // but for this demo a full applyEffect call on stop is fine.
            this.applyEffect(this.effectName); 
        }
    }

    startTimer() {
        let seconds = 0;
        const timerLabel = document.getElementById('record-timer');
        timerLabel.innerText = "00:00";
        this.timerInterval = setInterval(() => {
            seconds++;
            const m = Math.floor(seconds / 60).toString().padStart(2, '0');
            const s = (seconds % 60).toString().padStart(2, '0');
            timerLabel.innerText = `${m}:${s}`;
        }, 1000);
    }

    downloadRecording() {
        const blob = new Blob(this.recordedChunks, { type: 'audio/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `voice-capture-${new Date().toISOString().slice(0, 19).replace('T', '_')}.webm`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
    }
}

// Global App Init
window.addEventListener('load', () => {
    window.app = new VoiceChanger();
});
