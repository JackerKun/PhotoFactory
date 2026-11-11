"""Select available ONNX accelerators and fall back per model."""
import os
import threading

import onnxruntime as ort

_ACCELERATORS = ("CUDAExecutionProvider", "DmlExecutionProvider", "CoreMLExecutionProvider")
_registered = {}
_registry_lock = threading.Lock()


def available_providers():
    return ort.get_available_providers()


def loaded_providers():
    with _registry_lock:
        return dict(_registered)


class InferenceModel:
    def __init__(self, name, path, *, accelerate=True, static_batch_symbol=None):
        self.name, self.path = name, path
        self.static_batch_symbol = static_batch_symbol
        self.lock = threading.Lock()
        available = available_providers()
        requested = os.getenv("PHOTOFACTORY_AI_PROVIDER", "auto").strip().lower()
        choices = {
            "cuda": _ACCELERATORS[0], "directml": _ACCELERATORS[1],
            "coreml": _ACCELERATORS[2], "cpu": "CPUExecutionProvider",
        }
        preferred = _ACCELERATORS if requested == "auto" else (choices.get(requested),)
        for provider in preferred if accelerate else ():
            if provider not in available or provider == "CPUExecutionProvider":
                continue
            try:
                session = self._create(provider)
                if provider in session.get_providers():
                    self.session, self.provider = session, provider
                    break
            except Exception as exc:
                print(f"[AI] {name}: {provider} initialization failed: {exc}", flush=True)
        else:
            self.provider = "CPUExecutionProvider"
            self.session = self._create(self.provider)
        self._publish()

    def _create(self, provider):
        options = ort.SessionOptions()
        default_threads = max(1, min(4, (os.cpu_count() or 4) // 2))
        try:
            threads = int(os.getenv("PHOTOFACTORY_AI_THREADS", os.getenv("PHOTFACTORY_AI_THREADS", str(default_threads))))
        except ValueError:
            threads = default_threads
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = max(1, min(16, threads))
        providers = [provider]
        if provider != "CPUExecutionProvider":
            providers.append("CPUExecutionProvider")
        # ArcFace exports a dynamic input batch and a fixed output batch of
        # one. Give shape-sensitive backends a consistent static graph.
        if self.static_batch_symbol and provider in ("DmlExecutionProvider", "CoreMLExecutionProvider"):
            options.add_free_dimension_override_by_name(self.static_batch_symbol, 1)
        if provider == "DmlExecutionProvider":
            options.enable_mem_pattern = False
            options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        session = ort.InferenceSession(self.path, sess_options=options, providers=providers)
        session.disable_fallback()  # handle runtime errors here so diagnostics stay accurate
        return session

    def _publish(self):
        with _registry_lock:
            _registered[self.name] = self.provider
        print(f"[AI] {self.name}: {self.provider}", flush=True)

    def get_inputs(self):
        return self.session.get_inputs()

    def get_outputs(self):
        return self.session.get_outputs()

    def run(self, outputs, feeds):
        # DirectML does not allow concurrent Run on one session. The lock also
        # protects session replacement if an accelerator fails during inference.
        if self.provider == "CPUExecutionProvider":
            return self.session.run(outputs, feeds)
        with self.lock:
            try:
                return self.session.run(outputs, feeds)
            except Exception as exc:
                if self.provider == "CPUExecutionProvider":
                    raise
                print(f"[AI] {self.name}: {self.provider} execution failed, using CPU: {exc}", flush=True)
                self.session = self._create("CPUExecutionProvider")
                self.provider = "CPUExecutionProvider"
                self._publish()
                return self.session.run(outputs, feeds)
