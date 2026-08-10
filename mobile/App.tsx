/**
 * VoiceBridge mobile app (Expo)
 *
 * Two directions over one Convex bridge:
 *   laptop -> phone : VoiceOS writes a `commands` row, this app executes it here
 *   phone -> laptop : you hold the orb and talk, the recording is transcribed by a
 *                     Convex action, and VoiceOS picks it up and acts on the laptop
 *
 * CONVEX_URL below points at the deployment both sides share.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  SafeAreaView,
  Text,
  View,
  StyleSheet,
  Vibration,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  Animated,
  Easing,
  ScrollView,
} from "react-native";
import {
  ConvexProvider,
  ConvexReactClient,
  useQuery,
  useMutation,
  useAction,
} from "convex/react";
import { api } from "./convex/_generated/api";
import * as Location from "expo-location";
import * as Battery from "expo-battery";
import * as Haptics from "expo-haptics";
import * as Speech from "expo-speech";
import * as Brightness from "expo-brightness";
import {
  useAudioRecorder,
  useAudioRecorderState,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from "expo-audio";

const CONVEX_URL = "https://helpful-donkey-68.convex.cloud";
const convex = new ConvexReactClient(CONVEX_URL);

/** The voice the phone answers in. Samantha is the classic iOS assistant voice. */
const REPLY_VOICE_HINT = "samantha";

/**
 * Personas are pure data: a label, an emoji, and a prefix prepended to whatever you
 * dictate. The prefix is what tells VoiceOS which laptop tool to reach for.
 * Adding a persona is a two-line edit.
 */
const PERSONAS = [
  { emoji: "💻", name: "Coding Agent", short: "Code", prefix: "Using the coding agent on my laptop: " },
  { emoji: "✉️", name: "Email / Messages", short: "Inbox", prefix: "In my email or messages on my laptop: " },
  { emoji: "🔎", name: "Research", short: "Research", prefix: "Research this and reply to my phone: " },
  { emoji: "📅", name: "Calendar / Reminders", short: "Calendar", prefix: "On my laptop's calendar and reminders: " },
] as const;

type Stage = "idle" | "listening" | "thinking" | "sent" | "replied";

/* ------------------------------------------------------------------ *
 * The bridge rail: a lit dot crossing from the phone pole to the
 * laptop pole. Position is driven by real state, not decoration.
 * ------------------------------------------------------------------ */
function BridgeRail({ stage }: { stage: Stage }) {
  const pos = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const target = stage === "idle" ? 0 : stage === "listening" ? 0.08 : stage === "thinking" ? 0.35 : stage === "sent" ? 1 : 0;
    Animated.timing(pos, {
      toValue: target,
      duration: stage === "replied" ? 700 : 500,
      easing: Easing.inOut(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [stage, pos]);

  const travel = pos.interpolate({ inputRange: [0, 1], outputRange: [0, 220] });

  return (
    <View style={styles.rail}>
      <View style={[styles.pole, { backgroundColor: T.phone }]} />
      <View style={styles.railLine} />
      <View style={[styles.pole, { backgroundColor: T.laptop }]} />
      <Animated.View
        style={[
          styles.railDot,
          { transform: [{ translateX: travel }] },
          stage === "replied" && { backgroundColor: T.phone },
        ]}
      />
      <View style={styles.railLabels}>
        <Text style={styles.railLabel}>PHONE</Text>
        <Text style={styles.railLabel}>LAPTOP</Text>
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Hold-to-talk orb. Records, uploads to Convex, transcribes, queues.
 * ------------------------------------------------------------------ */
function VoiceOrb({
  personaIdx,
  onStage,
  onTranscript,
}: {
  personaIdx: number;
  onStage: (s: Stage) => void;
  onTranscript: (t: string) => void;
}) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder);
  const generateUploadUrl = useMutation(api.audio.generateUploadUrl);
  const transcribe = useAction(api.audio.transcribeAndEnqueue);

  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pulse = useRef(new Animated.Value(1)).current;
  const startedAt = useRef(0);

  /**
   * Preparing the recorder takes long enough that doing it on press-in eats the
   * whole hold — the first attempt recorded 68ms. Prepare ahead of time so
   * press-in only has to call record().
   */
  const prepare = useCallback(async () => {
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setError("Microphone access is off. Turn it on in Settings to talk.");
        setReady(false);
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      setReady(true);
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setReady(false);
    }
  }, [recorder]);

  useEffect(() => {
    prepare();
  }, [prepare]);

  useEffect(() => {
    if (recorderState.isRecording) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 1.12, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    }
    pulse.setValue(1);
  }, [recorderState.isRecording, pulse]);

  function startRecording() {
    setError(null);
    if (!ready) {
      setError("Microphone still warming up. Try again in a second.");
      return;
    }
    startedAt.current = Date.now();
    recorder.record();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onStage("listening");
  }

  async function stopAndSend() {
    if (!recorderState.isRecording) return;
    const held = Date.now() - startedAt.current;
    await recorder.stop();
    const uri = recorder.uri;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    // Too short to contain speech — don't waste an API call on it.
    if (held < 1000) {
      setError(`Only ${(held / 1000).toFixed(1)}s captured. Tap, speak a full sentence, then tap again.`);
      onStage("idle");
      prepare();
      return;
    }

    if (!uri) {
      setError("That recording came back empty. Hold a moment longer.");
      onStage("idle");
      prepare();
      return;
    }

    setBusy(true);
    onStage("thinking");
    try {
      const uploadUrl = await generateUploadUrl();
      const file = await fetch(uri);
      const blob = await file.blob();
      const up = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "audio/m4a" },
        body: blob,
      });
      if (!up.ok) throw new Error(`Upload failed (${up.status})`);
      const { storageId } = await up.json();

      const persona = PERSONAS[personaIdx];
      const { text } = await transcribe({
        storageId,
        persona: persona.name,
        prefix: persona.prefix,
      });
      onTranscript(text);
      onStage("sent");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      setError(String(e?.message ?? e));
      onStage("idle");
    } finally {
      setBusy(false);
      // The recorder must be prepared again before the next take.
      prepare();
    }
  }

  const label = recorderState.isRecording
    ? `Listening ${(recorderState.durationMillis / 1000).toFixed(1)}s — tap to send`
    : busy
      ? "Transcribing…"
      : ready
        ? "Tap to talk"
        : "Warming up the mic…";

  return (
    <View style={styles.orbWrap}>
      <Pressable
        onPress={() => (recorderState.isRecording ? stopAndSend() : startRecording())}
        disabled={busy}
        accessibilityLabel={
          recorderState.isRecording ? "Stop recording and send" : "Tap to talk to your laptop"
        }
      >
        <Animated.View
          style={[
            styles.orb,
            { transform: [{ scale: pulse }] },
            recorderState.isRecording && styles.orbLive,
            busy && styles.orbBusy,
          ]}
        >
          <View style={styles.orbCore} />
        </Animated.View>
      </Pressable>
      <Text style={styles.orbLabel}>{label}</Text>
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Executes commands sent from the laptop. run() is unchanged.
 * ------------------------------------------------------------------ */
function CommandRunner() {
  const pending = useQuery(api.commands.pending) ?? [];
  const complete = useMutation(api.commands.complete);
  const processed = useRef<Set<string>>(new Set());
  const [lastNote, setLastNote] = useState<string | null>(null);
  const [status, setStatus] = useState("Listening for commands…");

  const [personaIdx, setPersonaIdx] = useState(2); // Research reads its answer back
  const [stage, setStage] = useState<Stage>("idle");
  const [transcript, setTranscript] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const enqueue = useMutation(api.requests.enqueue);

  // Let the phone answer out loud even with the ringer switch on silent.
  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
  }, []);

  const speak = useCallback(async (text: string) => {
    try {
      const voices = await Speech.getAvailableVoicesAsync();
      const match = voices.find((v) =>
        `${v.name} ${v.identifier}`.toLowerCase().includes(REPLY_VOICE_HINT)
      );
      Speech.speak(text, { voice: match?.identifier, rate: 1.0 });
    } catch {
      Speech.speak(text);
    }
  }, []);

  useEffect(() => {
    for (const cmd of pending) {
      if (processed.current.has(cmd._id)) continue;
      processed.current.add(cmd._id);
      run(cmd).catch(async (e) => {
        await complete({ id: cmd._id, result: String(e?.message ?? e), status: "error" });
      });
    }
  }, [pending]);

  async function run(cmd: { _id: any; action: string; payload?: string }) {
    const payload = cmd.payload ? JSON.parse(cmd.payload) : {};
    setStatus(`Running: ${cmd.action}`);

    switch (cmd.action) {
      case "find_my_phone": {
        // Max brightness, vibrate, and literally shout — no audio asset needed
        try {
          const { status } = await Brightness.requestPermissionsAsync();
          if (status === "granted") await Brightness.setBrightnessAsync(1);
        } catch {}
        Vibration.vibrate([500, 300, 500, 300, 500]);
        for (let i = 0; i < 3; i++) {
          Speech.speak("I'm over here! Your phone is over here!", { rate: 1.0 });
          await new Promise((r) => setTimeout(r, 2500));
        }
        await complete({ id: cmd._id, result: "Phone is announcing itself now." });
        break;
      }

      case "get_location": {
        const perm = await Location.requestForegroundPermissionsAsync();
        if (perm.status !== "granted") throw new Error("Location permission denied on phone.");
        const loc = await Location.getCurrentPositionAsync({});
        let place = "";
        try {
          const rev = await Location.reverseGeocodeAsync(loc.coords);
          const p = rev[0];
          if (p) place = [p.name, p.street, p.city].filter(Boolean).join(", ");
        } catch {}
        const text = `Phone is at ${place || "an unknown address"} (lat ${loc.coords.latitude.toFixed(
          5
        )}, lon ${loc.coords.longitude.toFixed(5)}).`;
        await complete({ id: cmd._id, result: text });
        break;
      }

      case "send_note": {
        const msg = payload.message ?? "(empty note)";
        setLastNote(msg);
        setStage("replied");
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        speak(msg);
        await complete({ id: cmd._id, result: `Delivered to phone: "${msg}"` });
        break;
      }

      case "get_status": {
        const level = await Battery.getBatteryLevelAsync();
        const state = await Battery.getBatteryStateAsync();
        const charging = state === Battery.BatteryState.CHARGING ? "charging" : "not charging";
        await complete({
          id: cmd._id,
          result: `Battery at ${Math.round(level * 100)}%, ${charging}.`,
        });
        break;
      }

      default:
        throw new Error(`Unknown action: ${cmd.action}`);
    }
    setStatus("Listening for commands…");
  }

  async function sendTyped() {
    const body = typed.trim();
    if (!body) return;
    const p = PERSONAS[personaIdx];
    await enqueue({ persona: p.name, text: body, framed: p.prefix + body });
    setTranscript(body);
    setTyped("");
    setStage("sent");
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  return (
    <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <Text style={styles.wordmark}>VOICEBRIDGE</Text>
        <View style={styles.live}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>{status}</Text>
        </View>
      </View>

      <View style={styles.chips}>
        {PERSONAS.map((p, i) => (
          <Pressable
            key={p.name}
            onPress={() => setPersonaIdx(i)}
            style={[styles.chip, i === personaIdx && styles.chipOn]}
          >
            <Text style={[styles.chipText, i === personaIdx && styles.chipTextOn]}>
              {p.emoji}  {p.short}
            </Text>
          </Pressable>
        ))}
      </View>

      <VoiceOrb personaIdx={personaIdx} onStage={setStage} onTranscript={setTranscript} />

      <BridgeRail stage={stage} />

      {transcript && (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>YOU SAID</Text>
          <Text style={styles.said}>{transcript}</Text>
        </View>
      )}

      {lastNote && (
        <View style={[styles.card, styles.cardReply]}>
          <Text style={[styles.cardLabel, { color: T.phone }]}>FROM YOUR LAPTOP</Text>
          <Text style={styles.note}>{lastNote}</Text>
        </View>
      )}

      <View style={styles.fallback}>
        <TextInput
          style={styles.input}
          value={typed}
          onChangeText={setTyped}
          placeholder="…or type it"
          placeholderTextColor={T.muted}
          onSubmitEditing={sendTyped}
          returnKeyType="send"
        />
        <Pressable onPress={sendTyped} disabled={!typed.trim()} style={styles.sendBtn}>
          <Text style={styles.sendText}>Send</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

export default function App() {
  return (
    <ConvexProvider client={convex}>
      <SafeAreaView style={styles.container}>
        <KeyboardAvoidingView
          style={styles.container}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <CommandRunner />
        </KeyboardAvoidingView>
      </SafeAreaView>
    </ConvexProvider>
  );
}

/** Two poles — warm for the phone, cool for the laptop — bridged by indigo. */
const T = {
  bg: "#0B0E17",
  surface: "#141926",
  line: "#1F2637",
  phone: "#FFB35C",
  laptop: "#5CE1E6",
  link: "#7C6BFF",
  text: "#EDF0F7",
  muted: "#7A849B",
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: T.bg },
  body: { padding: 24, paddingBottom: 40 },

  header: { marginBottom: 28 },
  wordmark: {
    color: T.text,
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 4,
  },
  live: { flexDirection: "row", alignItems: "center", marginTop: 8, gap: 8 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: T.laptop },
  liveText: { color: T.muted, fontSize: 12 },

  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 32 },
  chip: {
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: T.surface,
    borderWidth: 1,
    borderColor: T.line,
  },
  chipOn: { backgroundColor: T.link, borderColor: T.link },
  chipText: { color: T.muted, fontSize: 13, fontWeight: "500" },
  chipTextOn: { color: "#fff", fontWeight: "700" },

  orbWrap: { alignItems: "center", marginBottom: 36 },
  orb: {
    width: 168,
    height: 168,
    borderRadius: 84,
    backgroundColor: T.surface,
    borderWidth: 1,
    borderColor: T.line,
    alignItems: "center",
    justifyContent: "center",
  },
  orbLive: { borderColor: T.link, backgroundColor: "#1A1730" },
  orbBusy: { borderColor: T.laptop },
  orbCore: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: T.link,
    opacity: 0.9,
  },
  orbLabel: { color: T.muted, fontSize: 13, marginTop: 18, letterSpacing: 0.3 },
  error: { color: T.phone, fontSize: 12, marginTop: 10, textAlign: "center" },

  rail: { height: 52, justifyContent: "center", marginBottom: 28 },
  railLine: {
    position: "absolute",
    left: 10,
    right: 10,
    height: 1,
    backgroundColor: T.line,
  },
  pole: {
    position: "absolute",
    width: 10,
    height: 10,
    borderRadius: 5,
    top: 21,
  },
  railDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: T.link,
    marginLeft: 11,
  },
  railLabels: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  railLabel: { color: T.muted, fontSize: 9, letterSpacing: 2, fontWeight: "700" },

  card: {
    backgroundColor: T.surface,
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderLeftWidth: 2,
    borderLeftColor: T.laptop,
  },
  cardReply: { borderLeftColor: T.phone },
  cardLabel: {
    color: T.laptop,
    fontSize: 9,
    letterSpacing: 2,
    fontWeight: "700",
    marginBottom: 8,
  },
  said: { color: T.text, fontSize: 16, lineHeight: 22 },
  note: { color: T.text, fontSize: 17, lineHeight: 24 },

  fallback: { flexDirection: "row", gap: 8, marginTop: 8 },
  input: {
    flex: 1,
    backgroundColor: T.surface,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: T.text,
    fontSize: 15,
    borderWidth: 1,
    borderColor: T.line,
  },
  sendBtn: {
    paddingHorizontal: 18,
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: T.surface,
    borderWidth: 1,
    borderColor: T.line,
  },
  sendText: { color: T.muted, fontSize: 14, fontWeight: "600" },
});
