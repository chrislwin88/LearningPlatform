let course = { title: "", lessons: [] };
let modules = course.lessons;
let currentCourseId = 1;
const lessonActivities = new Map();
const catalogActivities = new Map();
const activityAttempts = new Map();
const lessonViewModes = new Map();
const activityGenerationStates = new Map();
const videoDetailsById = new Map();
const videoDetailsStates = new Map();
const videoDetailsRequests = new Map();
const newlyAddedLessonIds = new Set();
const playbackPositionRequests = new Map();
const activityGenerationQueue = [];
let progress;
let currentModule = 0;
let activityGenerationRunning = false;
let youtubeApiPromise = null;
let youtubePlayer = null;
let youtubePlayerLessonId = null;
let youtubePlayerReadyPromise = null;
let youtubePlayerGeneration = 0;
let playbackSaveTimer = null;
const list = document.getElementById("moduleList");
const activities = document.getElementById("activities");
const videoView = document.getElementById("videoView");
const activitiesView = document.getElementById("activitiesView");
const saveStatus = document.getElementById("saveStatus");
const title = document.getElementById("title");
const videoDetails = document.getElementById("videoDetails");
const videoDetailsToggle = document.getElementById("videoDetailsToggle");
const videoDetailsContent = document.getElementById("videoDetailsContent");
const videoFrame = document.getElementById("videoFrame");
const explainerControl = document.getElementById("explainerControl");
const explainerButton = document.getElementById("explainerButton");
const explainerBubble = document.getElementById("explainerBubble");
const testKnowledgeButton = document.getElementById("testKnowledgeButton");
const backToVideoButton = document.getElementById("backToVideoButton");
const themeToggle = document.getElementById("themeToggle");
const themeIcon = document.getElementById("themeIcon");
const themeLabel = document.getElementById("themeLabel");
const sidebarToggle = document.getElementById("sidebarToggle");
const lessonEditorToggle = document.getElementById("lessonEditorToggle");
let currentTheme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
let activityDataError = false;
let currentActivities = null;
let pendingReflectionSave = null;
let editingLessons = false;
let forcedEmptyCourseEditor = false;
let draggingLessonId = null;
let removedLessonIds = new Set();
let showAddLessonForm = false;
let activeTitleEditor = null;
let progressSaveRevision = 0;
let progressMigrationBlocked = false;
let videoDetailsStartupPromise = Promise.resolve();
let activeExplainerRequest = null;
let explainerRequestSequence = 0;
let retainedExplainerResponse = null;
let retainedExplainerPlaybackTimer = null;
let sidebarManualOverride = false;
let sidebarWasNarrow = false;
const EXPLAINER_HELP_TEXT =
  "Get a quick explanation of the part you’re watching.";

testKnowledgeButton.addEventListener("click", () => openActivities());
backToVideoButton.addEventListener("click", () => setLearningView("video"));
themeToggle.addEventListener("click", toggleTheme);
sidebarToggle.addEventListener("click", toggleSidebar);
window.addEventListener("resize", syncSidebarToViewport);
lessonEditorToggle.addEventListener("click", toggleLessonEditor);
explainerButton.addEventListener("click", () => {
  void requestVideoExplanation();
});
explainerControl.addEventListener("pointerenter", restoreRetainedExplainer);
explainerControl.addEventListener("focusin", restoreRetainedExplainer);
videoDetails.addEventListener("toggle", () => {
  videoDetailsToggle.textContent = videoDetails.open
    ? "Hide video details"
    : "See video details";
});
document.addEventListener("click", (event) => {
  const target = event.target;
  const isTitleControl =
    target instanceof Element &&
    target.closest(
      "[data-title-editor], .module-title-edit-trigger, .course-title-edit-trigger"
    );
  if (!activeTitleEditor || isTitleControl) {
    return;
  }
  const editorKey = activeTitleEditor.key;
  window.setTimeout(() => {
    if (activeTitleEditor?.key === editorKey) {
      activeTitleEditor = null;
      renderModuleList();
    }
  }, 0);
});
document.addEventListener(
  "pointerdown",
  (event) => {
    if (
      explainerControl.classList.contains("is-active") &&
      !videoFrame.contains(event.target)
    ) {
      cancelVideoExplanation({ preserveResponse: true });
    }
  },
  true
);
window.addEventListener("pagehide", () => {
  cancelVideoExplanation();
  void flushPendingReflectionSave({ keepalive: true });
  void saveCurrentPlaybackPosition({ keepalive: true });
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    void saveCurrentPlaybackPosition({ keepalive: true });
  }
});
updateThemeControl();
syncSidebarToViewport();

async function readApiJson(response, action) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(
      `${action} returned a non-JSON response. Start the site with python3 server.py.`
    );
  }
  return response.json();
}

function renderVideoDetails(lesson, resetDisclosure = false) {
  const supported = lesson?.type === "youtube" &&
    typeof lesson.videoId === "string";
  const wasOpen = !resetDisclosure && videoDetails.open;
  videoDetails.hidden =
    !supported || lessonViewModes.get(lesson.id) === "activities";
  videoDetails.open = supported && wasOpen;
  videoDetailsToggle.textContent = videoDetails.open
    ? "Hide video details"
    : "See video details";
  videoDetailsContent.replaceChildren();
  if (!supported) {
    return;
  }

  const state = videoDetailsStates.get(lesson.videoId);
  const details = videoDetailsById.get(lesson.videoId);
  if (details) {
    const summaryHeading = document.createElement("p");
    const summary = document.createElement("p");
    summaryHeading.className = "video-details-summary-heading";
    summaryHeading.textContent = "Overview";
    summary.textContent = details.summary;
    videoDetailsContent.append(summaryHeading, summary);

    if (details.topics.length > 0) {
      const topicsHeading = document.createElement("p");
      const topics = document.createElement("ul");
      topicsHeading.className = "video-details-topics-heading";
      topicsHeading.textContent = "Key topics";
      topics.className = "video-details-topics";
      details.topics.forEach((topic) => {
        const item = document.createElement("li");
        const timestampButton = document.createElement("button");
        const topicTitle = document.createElement("span");
        const timestamp = formatVideoTimestamp(topic.timestampSeconds);
        timestampButton.type = "button";
        timestampButton.className = "video-topic-timestamp";
        timestampButton.textContent = timestamp;
        timestampButton.setAttribute("aria-label", `Seek to ${timestamp}`);
        timestampButton.addEventListener("click", () => {
          void seekToVideoTimestamp(lesson, topic.timestampSeconds);
        });
        topicTitle.textContent = topic.title;
        item.append(timestampButton, document.createTextNode(" — "), topicTitle);
        topics.appendChild(item);
      });
      videoDetailsContent.append(topicsHeading, topics);
    }
    return;
  }

  if (state?.status === "loading") {
    videoDetailsContent.textContent = "Preparing video details…";
    return;
  }
  if (state?.status === "failed") {
    const message = document.createElement("p");
    const retry = document.createElement("button");
    message.className = "video-details-error";
    message.textContent =
      `Video details could not be prepared: ${state.message}`;
    retry.type = "button";
    retry.className = "secondary-button video-details-retry";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => {
      void ensureVideoDetails(lesson, { retry: true });
    });
    videoDetailsContent.append(message, retry);
    return;
  }
  videoDetailsContent.textContent = "Video details are being checked.";
}

async function ensureVideoDetails(
  lesson,
  { retry = false, newLesson = false } = {}
) {
  if (lesson?.type !== "youtube" || typeof lesson.videoId !== "string") {
    return true;
  }
  const videoId = lesson.videoId;
  if (videoDetailsById.has(videoId)) {
    return true;
  }
  if (!retry && videoDetailsStates.get(videoId)?.status === "failed") {
    return false;
  }
  const existingRequest = videoDetailsRequests.get(videoId);
  if (existingRequest) {
    return existingRequest;
  }

  videoDetailsStates.set(videoId, { status: "loading" });
  if (modules[currentModule]?.videoId === videoId) {
    renderVideoDetails(modules[currentModule]);
  }

  const request = (async () => {
    try {
      const response = await fetch("/api/video-details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId, newLesson })
      });
      const result = await readApiJson(response, "Video details");
      if (!response.ok) {
        throw new Error(result.error ?? `Video details failed (${response.status}).`);
      }
      if (
        result.videoId !== videoId ||
        !result.details ||
        typeof result.details.summary !== "string" ||
        !Array.isArray(result.details.topics)
      ) {
        throw new Error("The server returned invalid video details.");
      }
      videoDetailsById.set(videoId, result.details);
      videoDetailsStates.set(videoId, { status: "ready" });
      if (modules[currentModule]?.videoId === videoId) {
        renderVideoDetails(modules[currentModule]);
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown server error.";
      videoDetailsStates.set(videoId, { status: "failed", message });
      if (modules[currentModule]?.videoId === videoId) {
        renderVideoDetails(modules[currentModule]);
      }
      return false;
    } finally {
      videoDetailsRequests.delete(videoId);
    }
  })();
  videoDetailsRequests.set(videoId, request);
  return request;
}

async function ensureVideoDetailsForLessons(lessons, newLessonIds = new Set()) {
  for (const lesson of lessons) {
    if (lesson.type === "youtube") {
      await ensureVideoDetails(lesson, {
        newLesson: newLessonIds.has(lesson.id)
      });
    }
  }
}

function formatVideoTimestamp(seconds) {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
    : `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function resetVideoExplainer() {
  explainerControl.classList.remove("is-active", "is-loading", "is-error");
  explainerButton.disabled = false;
  explainerBubble.textContent = EXPLAINER_HELP_TEXT;
}

function clearRetainedExplainer() {
  retainedExplainerResponse = null;
  if (retainedExplainerPlaybackTimer !== null) {
    window.clearInterval(retainedExplainerPlaybackTimer);
    retainedExplainerPlaybackTimer = null;
  }
}

function getActivePlaybackTime() {
  const lesson = modules[currentModule];
  if (!lesson) {
    return null;
  }
  if (
    lesson.type === "youtube" &&
    youtubePlayer &&
    youtubePlayerLessonId === lesson.id
  ) {
    try {
      const timestampSeconds = youtubePlayer.getCurrentTime();
      return Number.isFinite(timestampSeconds) ? timestampSeconds : null;
    } catch {
      return null;
    }
  }
  const video = document.querySelector("#playerContainer video");
  if (lesson.type === "video" && video && Number.isFinite(video.currentTime)) {
    return video.currentTime;
  }
  return null;
}

function invalidateRetainedExplainerIfPlaybackMoved() {
  if (!retainedExplainerResponse) {
    return;
  }
  if (modules[currentModule]?.id !== retainedExplainerResponse.lessonId) {
    clearRetainedExplainer();
    resetVideoExplainer();
    return;
  }
  const timestampSeconds = getActivePlaybackTime();
  if (
    timestampSeconds !== null &&
    Math.abs(timestampSeconds - retainedExplainerResponse.timestampSeconds) > 10
  ) {
    clearRetainedExplainer();
    resetVideoExplainer();
  }
}

function startRetainedExplainerPlaybackMonitor() {
  if (retainedExplainerPlaybackTimer !== null) {
    window.clearInterval(retainedExplainerPlaybackTimer);
  }
  retainedExplainerPlaybackTimer = window.setInterval(
    invalidateRetainedExplainerIfPlaybackMoved,
    250
  );
}

function retainedExplainerIsValid() {
  if (!retainedExplainerResponse) {
    return false;
  }
  if (
    modules[currentModule]?.id !== retainedExplainerResponse.lessonId ||
    youtubePlayerLessonId !== retainedExplainerResponse.lessonId ||
    !youtubePlayer
  ) {
    return false;
  }
  invalidateRetainedExplainerIfPlaybackMoved();
  return retainedExplainerResponse !== null;
}

function restoreRetainedExplainer() {
  if (!retainedExplainerResponse) {
    return;
  }
  if (!retainedExplainerIsValid()) {
    clearRetainedExplainer();
    resetVideoExplainer();
    return;
  }
  explainerControl.classList.add("is-active");
  explainerBubble.textContent = retainedExplainerResponse.explanation;
}

function cancelVideoExplanation({ preserveResponse = false } = {}) {
  explainerRequestSequence += 1;
  const request = activeExplainerRequest;
  activeExplainerRequest = null;
  if (request) {
    request.controller.abort();
  }
  if (!preserveResponse) {
    clearRetainedExplainer();
  }
  resetVideoExplainer();
}

function renderVideoExplainer(lesson) {
  const supported = lesson?.type === "youtube";
  explainerControl.hidden = !supported;
  if (!supported) {
    cancelVideoExplanation();
  }
}

async function requestVideoExplanation() {
  if (activeExplainerRequest) {
    return;
  }
  const lesson = modules[currentModule];
  if (
    lesson?.type !== "youtube" ||
    youtubePlayerLessonId !== lesson.id ||
    !youtubePlayer
  ) {
    explainerControl.classList.add("is-active", "is-error");
    explainerBubble.textContent =
      "The embedded video is not ready yet. Try again in a moment.";
    return;
  }

  let timestampSeconds;
  try {
    timestampSeconds = youtubePlayer.getCurrentTime();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Player time unavailable.";
    explainerControl.classList.add("is-active", "is-error");
    explainerBubble.textContent = `The video time could not be read: ${message}`;
    return;
  }
  if (!Number.isFinite(timestampSeconds) || timestampSeconds < 0) {
    explainerControl.classList.add("is-active", "is-error");
    explainerBubble.textContent = "The current video time is not available.";
    return;
  }

  clearRetainedExplainer();
  const controller = new AbortController();
  const requestId = ++explainerRequestSequence;
  activeExplainerRequest = {
    controller,
    lessonId: lesson.id,
    requestId
  };
  explainerControl.classList.remove("is-error");
  explainerControl.classList.add("is-active", "is-loading");
  explainerButton.disabled = true;
  explainerBubble.textContent =
    "Checking this moment against the wider video…";
  try {
    const response = await fetch("/api/video-explainer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId: lesson.videoId,
        timestampSeconds
      }),
      signal: controller.signal
    });
    const result = await readApiJson(response, "Video explanation");
    if (!response.ok) {
      throw new Error(
        result.error ?? `Explanation failed (${response.status}).`
      );
    }
    if (
      result.videoId !== lesson.videoId ||
      result.timestampSeconds !== timestampSeconds ||
      typeof result.explanation !== "string" ||
      !result.explanation.trim()
    ) {
      throw new Error("The server returned an invalid explanation.");
    }
    if (
      activeExplainerRequest?.requestId !== requestId ||
      modules[currentModule]?.id !== lesson.id
    ) {
      return;
    }
    const retainedResponse = {
      explanation: result.explanation,
      lessonId: lesson.id,
      timestampSeconds
    };
    retainedExplainerResponse = retainedResponse;
    startRetainedExplainerPlaybackMonitor();
    explainerBubble.textContent = result.explanation;
  } catch (error) {
    if (
      controller.signal.aborted ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      return;
    }
    if (
      activeExplainerRequest?.requestId !== requestId ||
      modules[currentModule]?.id !== lesson.id
    ) {
      return;
    }
    const message = error instanceof Error ? error.message : "Unknown server error.";
    explainerControl.classList.add("is-error");
    explainerBubble.textContent = `An explanation could not be prepared: ${message}`;
  } finally {
    if (activeExplainerRequest?.requestId === requestId) {
      activeExplainerRequest = null;
      explainerButton.disabled = false;
      explainerControl.classList.remove("is-loading");
    }
  }
}

function updateThemeControl() {
  const isDark = currentTheme === "dark";
  themeToggle.setAttribute("aria-pressed", String(isDark));
  themeToggle.setAttribute(
    "aria-label",
    `Switch to ${isDark ? "light" : "dark"} mode`
  );
  themeIcon.textContent = isDark ? "☀" : "☾";
  themeLabel.textContent = isDark ? "Light mode" : "Dark mode";
}

function toggleTheme() {
  currentTheme = currentTheme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = currentTheme;
  updateThemeControl();

  try {
    localStorage.setItem("learningPlatformTheme", currentTheme);
    saveStatus.textContent = `${currentTheme === "dark" ? "Dark" : "Light"} mode preference saved.`;
    saveStatus.classList.remove("save-status--error");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown storage error.";
    saveStatus.textContent =
      `Theme changed, but the preference could not be saved: ${message}`;
    saveStatus.classList.add("save-status--error");
  }
}

function toggleSidebar() {
  const container = document.querySelector(".container");
  const collapsed = container.classList.toggle("sidebar-collapsed");
  sidebarManualOverride = true;
  sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  sidebarToggle.setAttribute(
    "aria-label",
    collapsed ? "Expand lessons panel" : "Minimize lessons panel"
  );
  sidebarToggle.title = collapsed
    ? "Expand lessons panel"
    : "Minimize lessons panel";
}

function syncSidebarToViewport() {
  const isNarrow = window.matchMedia("(max-width: 899px)").matches;
  if (isNarrow && !sidebarWasNarrow) {
    sidebarManualOverride = false;
  }
  if (!isNarrow) {
    sidebarManualOverride = false;
  }
  sidebarWasNarrow = isNarrow;
  if (sidebarManualOverride) {
    return;
  }

  const container = document.querySelector(".container");
  const collapsed = container.classList.toggle("sidebar-collapsed", isNarrow);
  sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  sidebarToggle.setAttribute(
    "aria-label",
    collapsed ? "Expand lessons panel" : "Minimize lessons panel"
  );
  sidebarToggle.title = collapsed
    ? "Expand lessons panel"
    : "Minimize lessons panel";
}

function setLearningView(view) {
  const lessonId = modules[currentModule]?.id;
  if (lessonId !== undefined) {
    lessonViewModes.set(lessonId, view);
  }
  const showingActivities = view === "activities";
  if (showingActivities) {
    cancelVideoExplanation();
  }
  videoDetails.hidden =
    showingActivities || modules[currentModule]?.type !== "youtube";
  videoView.hidden = showingActivities;
  testKnowledgeButton.hidden = showingActivities;
  activitiesView.hidden = !showingActivities;
  testKnowledgeButton.setAttribute("aria-expanded", String(showingActivities));
  backToVideoButton.setAttribute("aria-expanded", String(!showingActivities));

  if (showingActivities) {
    void saveCurrentPlaybackPosition();
    const iframe = document.querySelector("#playerContainer iframe");
    if (iframe) {
      iframe.src = "about:blank";
    }
    document.querySelector("#playerContainer video")?.pause();
    destroyCurrentPlayer();
    backToVideoButton.focus();
    return;
  }

  renderPlayer(modules[currentModule]);
  testKnowledgeButton.focus();
}

async function openActivities() {
  const module = modules[currentModule];
  if (!module || !progress) {
    saveStatus.textContent = "Course activities are still loading.";
    return;
  }
  setLearningView("activities");
  const attempt = activityAttempts.get(module.id);
  if ((!attempt || attempt.source === "catalog") && !activityGenerationStates.has(module.id)) {
    if (progressMigrationBlocked) {
      activityGenerationStates.set(module.id, {
        state: "waiting-to-save",
        message: "Question generation is paused until existing learner progress can be migrated to SQLite."
      });
    } else if (editingLessons) {
      activityGenerationStates.set(module.id, {
        state: "waiting-to-save",
        message: "Save the lesson changes to start processing questions for this video."
      });
    } else {
      enqueueLessonGeneration(module.id);
    }
  }
  currentActivities = selectActivities(currentModule);
  renderActivities(currentModule);
}

function lessonHasSavedProgress(lessonId) {
  const lessonIndex = progress?.lessonIds?.indexOf(lessonId) ?? -1;
  if (lessonIndex < 0) {
    return false;
  }
  const saved = progress.lessons[lessonIndex];
  return saved.completed ||
    Object.keys(saved.quizAnswers).length > 0 ||
    Object.values(saved.reflections).some((response) => response.trim().length > 0);
}

function enqueueLessonGeneration(lessonId) {
  const attempt = activityAttempts.get(lessonId);
  const existingState = activityGenerationStates.get(lessonId);
  if (
    (attempt &&
      attempt.source !== "catalog" &&
      existingState?.mode !== "reattempt" &&
      existingState?.state !== "retry") ||
    existingState?.state === "queued" ||
    existingState?.state === "processing" ||
    existingState?.state === "ready" ||
    existingState?.state === "failed" ||
    existingState?.state === "preserved" ||
    existingState?.state === "waiting-to-save"
  ) {
    return;
  }
  if (lessonHasSavedProgress(lessonId)) {
    activityGenerationStates.set(lessonId, {
      state: "preserved",
      message: "Saved activities were kept because this lesson has learner responses or is complete."
    });
    renderGenerationStatusIfSelected(lessonId);
    return;
  }
  activityGenerationStates.set(lessonId, {
    state: "queued",
    mode: existingState?.mode ?? "start",
    requestMode: existingState?.requestMode
  });
  activityGenerationQueue.push(lessonId);
  renderGenerationStatusIfSelected(lessonId);
  void processActivityGenerationQueue();
}

function retryLessonGeneration(lessonId) {
  const failedState = activityGenerationStates.get(lessonId);
  if (failedState?.state !== "failed") {
    return;
  }
  if (failedState.mode === "reattempt") {
    activityAttempts.delete(lessonId);
    lessonActivities.set(lessonId, { quizzes: [], reflections: [] });
    const lessonIndex = progress.lessonIds.indexOf(lessonId);
    if (lessonIndex >= 0) {
      progress.lessons[lessonIndex] = {
        quizAnswers: {},
        reflections: {},
        completed: false
      };
    }
    progress.activityDecks[lessonId] = {
      quizOrder: [],
      quizRevealCount: 0,
      reflectionOrder: [],
      reflectionRevealCount: 0
    };
    if (modules[currentModule]?.id === lessonId) {
      currentActivities = { quizzes: [], reflections: [] };
    }
  }
  activityGenerationStates.set(lessonId, {
    state: "retry",
    mode: failedState.mode ?? "start",
    requestMode: "retry"
  });
  enqueueLessonGeneration(lessonId);
  renderGenerationStatusIfSelected(lessonId);
}

function queueEligibleLessons() {
  const currentLessonId = modules[currentModule]?.id;
  const orderedLessons = [
    ...modules.filter((module) => module.id === currentLessonId),
    ...modules.filter((module) => module.id !== currentLessonId)
  ];
  orderedLessons.forEach((module) => enqueueLessonGeneration(module.id));
}

function renderGenerationStatusIfSelected(lessonId) {
  if (modules[currentModule]?.id === lessonId && lessonViewModes.get(lessonId) === "activities") {
    currentActivities = selectActivities(currentModule);
    renderActivities(currentModule);
  }
}

async function processActivityGenerationQueue() {
  if (activityGenerationRunning) {
    return;
  }
  activityGenerationRunning = true;
  try {
    while (activityGenerationQueue.length > 0) {
      await videoDetailsStartupPromise;
      const lessonId = activityGenerationQueue.shift();
      const lesson = modules.find((module) => module.id === lessonId);
      if (!lesson || activityGenerationStates.get(lessonId)?.state !== "queued") {
        continue;
      }
      if (lessonHasSavedProgress(lessonId)) {
        activityGenerationStates.set(lessonId, {
          state: "preserved",
          message: "Saved activities were kept because this lesson has learner responses or is complete."
        });
        renderGenerationStatusIfSelected(lessonId);
        continue;
      }

      await ensureVideoDetails(lesson);
      if (
        !modules.some((module) => module.id === lessonId) ||
        activityGenerationStates.get(lessonId)?.state !== "queued"
      ) {
        continue;
      }
      const generationMode =
        activityGenerationStates.get(lessonId)?.requestMode ??
        activityGenerationStates.get(lessonId)?.mode ??
        "start";
      activityGenerationStates.set(lessonId, {
        state: "processing",
        mode: activityGenerationStates.get(lessonId)?.mode ?? generationMode
      });
      renderGenerationStatusIfSelected(lessonId);
      try {
        await flushPendingReflectionSave();
        const response = await fetch("/api/activity-attempt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lessonId, mode: generationMode })
        });
        const result = await readApiJson(response, "Activity generation");
        if (!response.ok) {
          throw new Error(result.error ?? `Activity generation failed (${response.status}).`);
        }

        if (result.attempt) {
          updateActivityAttempt(
            lessonId,
            result.attempt,
            result.attempt.resetResponses
          );
        }
        if (result.generationState?.status === "failed") {
          activityGenerationStates.set(lessonId, {
            state: "failed",
            mode: result.generationState.mode,
            message: `Questions could not be prepared: ${result.generationState.failureReason || "Generation failed."}`
          });
        } else if (result.attempt?.skippedReason) {
          activityGenerationStates.set(lessonId, {
            state: "preserved",
            message: result.attempt.skippedReason
          });
        } else if (result.attempt) {
          activityGenerationStates.set(lessonId, { state: "ready" });
          const saved = await persistProgress("Activity attempt saved to SQLite.");
          if (!saved.ok) {
            activityGenerationStates.set(lessonId, {
              state: "ready"
            });
          }
        } else {
          throw new Error("The server returned no questions and no generation status.");
        }
        renderGenerationStatusIfSelected(lessonId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown server error.";
        activityGenerationStates.set(lessonId, {
          state: "failed",
          mode: generationMode,
          message: `Questions could not be prepared: ${message}`
        });
        renderGenerationStatusIfSelected(lessonId);
      }
    }
  } finally {
    activityGenerationRunning = false;
    if (activityGenerationQueue.length > 0) {
      void processActivityGenerationQueue();
    }
  }
}

function updateActivityAttempt(lessonId, attempt, resetResponses = false) {
  if (
    !attempt ||
    !["catalog", "generated", "fallback"].includes(attempt.source) ||
    !attempt.activities ||
    !Array.isArray(attempt.activities.quizzes) ||
    !Array.isArray(attempt.activities.reflections) ||
    (attempt.generationDurationSeconds !== null &&
      attempt.generationDurationSeconds !== undefined &&
      (!Number.isFinite(attempt.generationDurationSeconds) ||
        attempt.generationDurationSeconds < 0))
  ) {
    throw new Error("The server returned an invalid activity attempt.");
  }
  activityAttempts.set(lessonId, attempt);
  lessonActivities.set(lessonId, attempt.activities);
  if (resetResponses && progress) {
    const lessonIndex = progress.lessonIds.indexOf(lessonId);
    if (lessonIndex >= 0) {
      progress.lessons[lessonIndex] = {
        quizAnswers: {},
        reflections: {},
        completed: false
      };
    }
    progress.activityDecks[lessonId] = {
      quizOrder: [],
      quizRevealCount: Math.min(2, attempt.activities.quizzes.length),
      reflectionOrder: [],
      reflectionRevealCount: Math.min(1, attempt.activities.reflections.length)
    };
  }
  progress = reconcileProgress(progress, modules, lessonActivities);
  renderModuleList();
}

function applyActivityGenerationStates(states) {
  if (!states || typeof states !== "object" || Array.isArray(states)) {
    throw new Error("Saved activity generation states have an unsupported format.");
  }
  Object.entries(states).forEach(([lessonIdText, state]) => {
    const lessonId = Number(lessonIdText);
    if (!Number.isInteger(lessonId) || !catalogActivities.has(lessonId)) {
      return;
    }
    if (!state || !["pending", "failed"].includes(state.status)) {
      throw new Error(`Saved activity generation state for lesson ${lessonId} is invalid.`);
    }
    const mappedState = {
      state: state.status === "pending" ? "resume-pending" : "failed",
      mode: state.mode,
      message: state.failureReason
        ? `Questions could not be prepared: ${state.failureReason}`
        : undefined
    };
    activityGenerationStates.set(lessonId, mappedState);
    if (state.status === "pending" && state.mode === "reattempt") {
      activityAttempts.delete(lessonId);
      lessonActivities.set(lessonId, { quizzes: [], reflections: [] });
    }
  });
}

function getLessonProgress(index) {
  const lessonId = modules[index]?.id;
  const savedIndex = progress?.lessonIds?.indexOf(lessonId) ?? -1;
  return savedIndex >= 0 ? progress.lessons[savedIndex] : {
    quizAnswers: {},
    reflections: {},
    completed: false
  };
}

async function persistProgress(message = "Progress saved to SQLite.") {
  if (progressMigrationBlocked) {
    const result = {
      ok: false,
      message: "Progress is not being saved until the existing browser data can be migrated."
    };
    saveStatus.textContent = result.message;
    saveStatus.classList.add("save-status--error");
    return result;
  }
  const revision = ++progressSaveRevision;
  saveStatus.textContent = "Saving progress to SQLite…";
  saveStatus.classList.remove("save-status--error");
  const result = await saveProgress(progress, { courseId: currentCourseId });
  if (revision === progressSaveRevision) {
    saveStatus.textContent = result.ok ? message : result.message;
    saveStatus.classList.toggle("save-status--error", !result.ok);
  }
  return result;
}

async function flushPendingReflectionSave({ keepalive = false } = {}) {
  if (!pendingReflectionSave || !progress) {
    return;
  }

  clearTimeout(pendingReflectionSave.timer);
  const { statuses } = pendingReflectionSave;
  pendingReflectionSave = null;
  const result = progressMigrationBlocked
    ? {
        ok: false,
        message: "Progress is not being saved until the existing browser data can be migrated."
      }
    : await saveProgress(progress, { keepalive, courseId: currentCourseId });

  statuses.forEach((status) => {
    if (!status.isConnected) {
      return;
    }
    status.textContent = result.ok ? "Saved automatically." : result.message;
    status.classList.toggle("activity-save-status--error", !result.ok);
  });
  if (!result.ok) {
    saveStatus.textContent = result.message;
    saveStatus.classList.add("save-status--error");
  } else {
    saveStatus.textContent = "Reflection saved to SQLite.";
    saveStatus.classList.remove("save-status--error");
  }
}

function shuffle(items) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function selectActivities(index) {
  const module = modules[index];
  const activity = lessonActivities.get(module.id);
  if (
    !activity ||
    !Array.isArray(activity.quizzes) ||
    !Array.isArray(activity.reflections)
  ) {
    return null;
  }
  if (activity.quizzes.length === 0 || activity.reflections.length === 0) {
    return { quizzes: [], reflections: [] };
  }

  const deck = progress.activityDecks[module.id];
  if (!Array.isArray(deck.quizOrder) || deck.quizOrder.length === 0) {
    deck.quizOrder = shuffle(activity.quizzes.map((item) => item.id));
    deck.quizRevealCount = Math.min(2, deck.quizOrder.length);
  }
  if (!Array.isArray(deck.reflectionOrder) || deck.reflectionOrder.length === 0) {
    deck.reflectionOrder = shuffle(activity.reflections.map((item) => item.id));
    deck.reflectionRevealCount = Math.min(1, deck.reflectionOrder.length);
  }

  return {
    quizzes: deck.quizOrder
      .slice(0, deck.quizRevealCount)
      .map((id) => activity.quizzes.find((item) => item.id === id))
      .filter(Boolean),
    reflections: deck.reflectionOrder
      .slice(0, deck.reflectionRevealCount)
      .map((id) => activity.reflections.find((item) => item.id === id))
      .filter(Boolean)
  };
}

function getCompletionRequirements(index) {
  const module = modules[index];
  const lessonProgress = getLessonProgress(index);
  const deck = progress.activityDecks[module.id];
  const visibleQuizIds = deck.quizOrder.slice(0, deck.quizRevealCount);
  const answeredCount = visibleQuizIds.filter((id) =>
    Number.isInteger(lessonProgress.quizAnswers[id])
  ).length;
  const visibleReflectionIds = deck.reflectionOrder.slice(0, deck.reflectionRevealCount);
  const hasReflection = visibleReflectionIds.some(
    (id) => (lessonProgress.reflections[id] ?? "").trim().length > 0
  );
  return {
    answeredCount,
    hasReflection,
    isComplete: answeredCount >= 2 && hasReflection
  };
}

function updateCompletionRequirements(index) {
  const requirements = document.getElementById("completionRequirements");
  const completionButton = document.querySelector(".completion-button");
  if (!requirements || !completionButton) {
    return;
  }

  const validation = getCompletionRequirements(index);
  const lessonProgress = getLessonProgress(index);
  if (lessonProgress.completed) {
    requirements.textContent = "Lesson requirements met.";
    completionButton.disabled = false;
    return;
  }

  const quizStatus =
    validation.answeredCount >= 2
      ? "2 quiz questions answered"
      : `${validation.answeredCount}/2 quiz questions answered`;
  const reflectionStatus = validation.hasReflection
    ? "reflection written"
    : "reflection still needed";
  requirements.textContent = `To complete: ${quizStatus} and ${reflectionStatus}.`;
  completionButton.disabled = !validation.isComplete;
}

function renderModuleList() {
  const focusedTitleInput = document.activeElement?.matches("[data-title-editor]")
    ? {
        key: document.activeElement.dataset.titleEditor,
        start: document.activeElement.selectionStart,
        end: document.activeElement.selectionEnd
      }
    : null;
  list.replaceChildren();
  renderCourseTitle();

  modules.forEach((module, index) => {
    const row = document.createElement("div");
    const button = document.createElement("button");

    row.className = "module-row";
    row.classList.toggle("module-row--active", index === currentModule);
    row.draggable =
      editingLessons &&
      !(
        activeTitleEditor?.type === "lesson" &&
        activeTitleEditor.lessonId === module.id
      );
    row.dataset.lessonId = String(module.id);

    if (editingLessons) {
      const editorKey = `lesson-${module.id}`;
      let titleControl;
      if (
        activeTitleEditor?.type === "lesson" &&
        activeTitleEditor.lessonId === module.id
      ) {
        titleControl = document.createElement("input");
        titleControl.type = "text";
        titleControl.className = "inline-title-input module-title-input";
        titleControl.value = module.title;
        titleControl.setAttribute("aria-label", `Lesson ${index + 1} title`);
        titleControl.dataset.titleEditor = editorKey;
        titleControl.addEventListener("input", () => {
          module.title = titleControl.value;
          titleControl.setAttribute(
            "aria-invalid",
            String(!titleControl.value.trim())
          );
        });
      } else {
        titleControl = document.createElement("button");
        titleControl.type = "button";
        titleControl.className = "module-title-edit-trigger";
        titleControl.textContent = `${index + 1}. ${module.title}`;
        titleControl.setAttribute(
          "aria-label",
          `Edit lesson title: ${module.title}`
        );
        titleControl.addEventListener("click", () =>
          beginInlineTitleEdit("lesson", module.id)
        );
      }
      row.appendChild(titleControl);
    } else {
      const lessonProgress = getLessonProgress(index);
      const hasStarted =
        Object.keys(lessonProgress.quizAnswers).length > 0 ||
        Object.values(lessonProgress.reflections).some((reflection) => reflection.length > 0);
      const status = document.createElement("span");
      status.className = "module-status";
      status.textContent = lessonProgress.completed
        ? "Complete"
        : hasStarted
          ? "In progress"
          : "Not started";
      const label = document.createElement("span");
      label.textContent = `${index + 1}. ${module.title}`;
      button.type = "button";
      button.className = "module";
      button.classList.toggle("active", index === currentModule);
      button.setAttribute("aria-current", index === currentModule ? "step" : "false");
      button.addEventListener("click", () => loadModule(index));
      button.append(label, status);
      row.appendChild(button);
    }

    if (editingLessons) {
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "icon-button remove-lesson-button";
      removeButton.setAttribute("aria-label", `Remove ${module.title}`);
      removeButton.title = `Remove ${module.title}`;
      removeButton.appendChild(createEditorIcon("x"));
      removeButton.disabled = modules.length <= 1;
      removeButton.addEventListener("click", () => removeLesson(module.id));
      row.appendChild(removeButton);

      row.addEventListener("dragstart", (event) => {
        if (
          event.target instanceof Element &&
          event.target.closest(".inline-title-input, .remove-lesson-button")
        ) {
          event.preventDefault();
          return;
        }
        draggingLessonId = module.id;
        row.classList.add("module-row--dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(module.id));
      });
      row.addEventListener("dragend", () => {
        draggingLessonId = null;
        row.classList.remove("module-row--dragging");
        list.querySelectorAll(".module-row--drop-target").forEach((item) =>
          item.classList.remove("module-row--drop-target")
        );
      });
      row.addEventListener("dragover", (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        row.classList.add("module-row--drop-target");
      });
      row.addEventListener("dragleave", (event) => {
        if (!row.contains(event.relatedTarget)) {
          row.classList.remove("module-row--drop-target");
        }
      });
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        row.classList.remove("module-row--drop-target");
        reorderLesson(draggingLessonId, module.id, event.clientY, row);
      });
    }
    list.appendChild(row);
  });

  if (editingLessons) {
    if (showAddLessonForm) {
      renderAddLessonForm();
    }
    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "icon-button add-lesson-button";
    addButton.setAttribute("aria-label", "Add lesson");
    addButton.title = "Add lesson";
    addButton.textContent = "+";
    addButton.addEventListener("click", () => {
      showAddLessonForm = !showAddLessonForm;
      renderModuleList();
      if (showAddLessonForm) {
        list.querySelector("#newLessonTitle")?.focus();
      }
    });
    list.appendChild(addButton);
  }

  const completedCount = modules.filter(
    (_, index) => getLessonProgress(index).completed
  ).length;
  const courseProgress = document.getElementById("courseProgress");
  courseProgress.textContent = `${completedCount} of ${modules.length} lessons complete`;
  if (focusedTitleInput) {
    const replacement = document.querySelector(
      `[data-title-editor="${focusedTitleInput.key}"]`
    );
    if (replacement) {
      replacement.focus();
      if (
        Number.isInteger(focusedTitleInput.start) &&
        Number.isInteger(focusedTitleInput.end)
      ) {
        replacement.setSelectionRange(
          focusedTitleInput.start,
          focusedTitleInput.end
        );
      }
    }
  }
  lessonEditorToggle.setAttribute("aria-pressed", String(editingLessons));
  lessonEditorToggle.setAttribute(
    "aria-label",
    editingLessons ? "Save lesson changes" : "Edit lessons"
  );
  lessonEditorToggle.title = editingLessons ? "Save lesson changes" : "Edit lessons";
  lessonEditorToggle.querySelector("span").replaceChildren(
    createEditorIcon(editingLessons ? "check" : "pencil")
  );
  lessonEditorToggle.hidden = forcedEmptyCourseEditor && modules.length === 0;
  lessonEditorToggle.disabled = !forcedEmptyCourseEditor && modules.length === 0;
}

function renderCourseTitle() {
  const heading = document.getElementById("courseTitle");
  heading.replaceChildren();
  if (!editingLessons) {
    heading.textContent = course.title;
    return;
  }

  if (activeTitleEditor?.type === "course") {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "inline-title-input course-title-input";
    input.value = course.title;
    input.setAttribute("aria-label", "Course name");
    input.dataset.titleEditor = "course";
    input.addEventListener("input", () => {
      course.title = input.value;
      input.setAttribute("aria-invalid", String(!input.value.trim()));
    });
    heading.appendChild(input);
    return;
  }

  const titleButton = document.createElement("button");
  titleButton.type = "button";
  titleButton.className = "course-title-edit-trigger";
  titleButton.textContent = course.title;
  titleButton.setAttribute("aria-label", `Edit course name: ${course.title}`);
  titleButton.addEventListener("focus", () => beginInlineTitleEdit("course"));
  titleButton.addEventListener("click", () => beginInlineTitleEdit("course"));
  heading.appendChild(titleButton);
}

function beginInlineTitleEdit(type, lessonId = null) {
  if (!editingLessons) {
    return;
  }
  const key = type === "course" ? "course" : `lesson-${lessonId}`;
  if (
    activeTitleEditor?.type === type &&
    (type === "course" || activeTitleEditor.lessonId === lessonId)
  ) {
    return;
  }
  activeTitleEditor = { type, lessonId, key };
  renderModuleList();
  const input = document.querySelector(`[data-title-editor="${key}"]`);
  input?.focus();
  input?.setSelectionRange(input.value.length, input.value.length);
}

function createEditorIcon(name) {
  const paths = {
    pencil: [
      [
        "path",
        {
          d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"
        }
      ],
      ["path", { d: "m15 5 4 4" }]
    ],
    check: [["path", { d: "M20 6 9 17l-5-5" }]],
    x: [
      ["path", { d: "M18 6 6 18" }],
      ["path", { d: "m6 6 12 12" }]
    ]
  };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("editor-icon");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  paths[name].forEach(([tagName, attributes]) => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", tagName);
    Object.entries(attributes).forEach(([attribute, value]) => {
      path.setAttribute(attribute, value);
    });
    svg.appendChild(path);
  });
  return svg;
}

function toggleLessonEditor() {
  if (!editingLessons) {
    editingLessons = true;
    removedLessonIds = new Set();
    showAddLessonForm = false;
    saveStatus.textContent = "Edit lessons, then select the check mark to save changes.";
    saveStatus.classList.remove("save-status--error");
    renderModuleList();
    return;
  }

  saveLessonChanges();
}

function buildCatalog() {
  return {
    title: course.title.trim(),
    lessons: modules.map((module) => {
      const activities = catalogActivities.get(module.id);
      const lessonData = { ...module };
      delete lessonData.activities;
      if (lessonData.type === "youtube") {
        lessonData.videoId = lessonData.videoId.split("&", 1)[0];
      }
      return {
        ...lessonData,
        title: module.title.trim(),
        activities: {
          legacyResponseTarget: activities.legacyResponseTarget,
          quizzes: activities.quizzes,
          reflections: activities.reflections
        }
      };
    })
  };
}

function applyCatalog(catalog) {
  if (
    !catalog ||
    typeof catalog.title !== "string" ||
    !catalog.title.trim() ||
    !Array.isArray(catalog.lessons)
  ) {
    throw new Error("The saved course catalog has an unsupported format.");
  }

  const ids = new Set();
  const nextLessons = [];
  const nextActivities = new Map();
  catalog.lessons.forEach((savedLesson) => {
    if (
      !savedLesson ||
      !Number.isInteger(savedLesson.id) ||
      savedLesson.id <= 0 ||
      ids.has(savedLesson.id) ||
      typeof savedLesson.title !== "string" ||
      !savedLesson.title.trim() ||
      !savedLesson.activities ||
      !Array.isArray(savedLesson.activities.quizzes) ||
      !Array.isArray(savedLesson.activities.reflections)
    ) {
      throw new Error("The saved course catalog contains an invalid lesson.");
    }

    ids.add(savedLesson.id);
    const lesson = { ...savedLesson };
    delete lesson.activities;
    nextLessons.push(lesson);
    nextActivities.set(savedLesson.id, savedLesson.activities);
  });

  course.title = catalog.title.trim();
  course.lessons = nextLessons;
  modules = course.lessons;
  catalogActivities.clear();
  lessonActivities.clear();
  activityAttempts.clear();
  activityGenerationStates.clear();
  nextActivities.forEach((activities, id) => {
    catalogActivities.set(id, activities);
    lessonActivities.set(id, activities);
  });
  renderCourseTitle();
  document.getElementById("documentTitle").textContent = `${course.title} | LearnHub`;
}

function applyActivityAttempts(attempts) {
  if (!attempts || typeof attempts !== "object" || Array.isArray(attempts)) {
    throw new Error("Saved activity attempts have an unsupported format.");
  }
  Object.entries(attempts).forEach(([lessonIdText, attempt]) => {
    const lessonId = Number(lessonIdText);
    if (!Number.isInteger(lessonId) || !catalogActivities.has(lessonId)) {
      return;
    }
    if (
      !attempt ||
      !["catalog", "generated", "fallback"].includes(attempt.source) ||
      !attempt.activities ||
      !Array.isArray(attempt.activities.quizzes) ||
      !Array.isArray(attempt.activities.reflections)
    ) {
      throw new Error(`Saved activity attempt for lesson ${lessonId} is invalid.`);
    }
    activityAttempts.set(lessonId, attempt);
    lessonActivities.set(lessonId, attempt.activities);
  });
}

async function saveLessonChanges() {
  if (forcedEmptyCourseEditor && modules.length === 0) {
    saveStatus.textContent = "Add at least one video lesson before saving the course.";
    saveStatus.classList.add("save-status--error");
    return;
  }
  const invalidTitle = [course, ...modules].find(
    (item) => typeof item.title !== "string" || !item.title.trim()
  );
  if (invalidTitle) {
    saveStatus.textContent = "Course and lesson titles cannot be empty.";
    saveStatus.classList.add("save-status--error");
    const invalidInput = document.querySelector(
      '[data-title-editor][aria-invalid="true"]'
    );
    invalidInput?.focus();
    return;
  }
  if (progressMigrationBlocked) {
    saveStatus.textContent =
      "Lesson changes cannot be saved until learner progress migration succeeds.";
    saveStatus.classList.add("save-status--error");
    return;
  }
  lessonEditorToggle.disabled = true;
  saveStatus.textContent = "Saving lesson changes…";
  saveStatus.classList.remove("save-status--error");

  try {
    const response = await fetch("/api/catalog", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ courseId: currentCourseId, catalog: buildCatalog() })
    });
    const result = await readApiJson(response, "Catalog save");
    if (!response.ok) {
      throw new Error(result.error ?? `Catalog save failed (${response.status}).`);
    }

    course.title = course.title.trim();
    modules.forEach((module) => {
      module.title = module.title.trim();
    });
    document.getElementById("documentTitle").textContent =
      `${course.title} | LearnHub`;
    progress.currentModuleId = modules[currentModule]?.id ?? null;
    const nextProgress = reconcileProgress(progress, modules, lessonActivities);
    progress = nextProgress;
    currentModule = progress.currentModule;
    const progressSave = await saveProgress(progress, {
      courseId: currentCourseId
    });
    const newLessonIds = new Set(
      modules
        .filter((module) => newlyAddedLessonIds.has(module.id))
        .map((module) => module.id)
    );
    newlyAddedLessonIds.clear();
    editingLessons = false;
    forcedEmptyCourseEditor = false;
    activeTitleEditor = null;
    showAddLessonForm = false;
    removedLessonIds.clear();
    renderModuleList();
    loadModule(currentModule, false);
    videoDetailsStartupPromise = ensureVideoDetailsForLessons(modules, newLessonIds);

    if (progressSave.ok) {
      saveStatus.textContent = "Lesson changes saved.";
      saveStatus.classList.remove("save-status--error");
      queueEligibleLessons();
    } else {
      saveStatus.textContent =
        `Lesson catalog saved, but learner progress could not be updated: ${progressSave.message}`;
      saveStatus.classList.add("save-status--error");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    saveStatus.textContent = `Lesson changes could not be saved: ${message}`;
    saveStatus.classList.add("save-status--error");
  } finally {
    lessonEditorToggle.disabled = false;
  }
}

function reorderLesson(draggedId, targetId, pointerY, targetRow) {
  if (!editingLessons || draggedId === null || draggedId === targetId) {
    return;
  }

  const activeId = modules[currentModule]?.id;
  const draggedIndex = modules.findIndex((module) => module.id === draggedId);
  const targetIndex = modules.findIndex((module) => module.id === targetId);
  if (draggedIndex < 0 || targetIndex < 0) {
    return;
  }

  const [draggedLesson] = modules.splice(draggedIndex, 1);
  let insertionIndex = modules.findIndex((module) => module.id === targetId);
  const targetBounds = targetRow.getBoundingClientRect();
  if (pointerY >= targetBounds.top + targetBounds.height / 2) {
    insertionIndex += 1;
  }
  modules.splice(insertionIndex, 0, draggedLesson);
  currentModule = Math.max(modules.findIndex((module) => module.id === activeId), 0);
  course.lessons = modules;
  renderModuleList();
}

function removeLesson(lessonId) {
  if (modules.length <= 1) {
    return;
  }
  const lessonIndex = modules.findIndex((module) => module.id === lessonId);
  const lesson = modules[lessonIndex];
  if (
    lessonIndex < 0 ||
    !window.confirm(
      `Remove "${lesson.title}" from this course? Its saved quiz answers, reflections, completion, and activity order will also be deleted when you save.`
    )
  ) {
    return;
  }

  const activeId = modules[currentModule]?.id;
  modules.splice(lessonIndex, 1);
  lessonActivities.delete(lessonId);
  removedLessonIds.add(lessonId);
  if (activeId === lessonId) {
    currentModule = Math.min(lessonIndex, modules.length - 1);
    loadModule(currentModule, false);
  } else {
    currentModule = modules.findIndex((module) => module.id === activeId);
    renderModuleList();
  }
  course.lessons = modules;
}

function parseVideoUrl(value) {
  let parsedUrl;
  try {
    parsedUrl = new URL(value.trim());
  } catch {
    return { error: "Enter a valid YouTube or direct video URL." };
  }

  if (
    !["http:", "https:"].includes(parsedUrl.protocol) ||
    !parsedUrl.hostname ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    return { error: "Use a public HTTP or HTTPS video URL." };
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  if (hostname === "youtu.be" || hostname.endsWith(".youtube.com") || hostname === "youtube.com") {
    const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
    const videoId =
      hostname === "youtu.be"
        ? pathParts[0]
        : parsedUrl.searchParams.get("v") ??
          (["embed", "shorts", "live"].includes(pathParts[0]) ? pathParts[1] : null);
    if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      return { error: "That YouTube link does not contain a valid video ID." };
    }
    return {
      lesson: { type: "youtube", videoId },
      url: `https://www.youtube.com/watch?v=${videoId}`
    };
  }

  const extension = parsedUrl.pathname.match(/\.(mp4|webm|ogg)$/i)?.[1]?.toLowerCase();
  if (!extension) {
    return { error: "Direct video links must end in .mp4, .webm, or .ogg." };
  }
  return { lesson: { type: "video", src: parsedUrl.href }, url: parsedUrl.href };
}

function getVideoFilenameTitle(value) {
  const parsedUrl = new URL(value);
  const encodedName = parsedUrl.pathname.split("/").pop() ?? "";
  let filename;
  try {
    filename = decodeURIComponent(encodedName);
  } catch {
    filename = encodedName;
  }
  const title = filename
    .replace(/\.(mp4|webm|ogg)$/i, "")
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  return title || "Video lesson";
}

function renderAddLessonForm() {
  const form = document.createElement("form");
  const titleLabel = document.createElement("label");
  const titleInput = document.createElement("input");
  const urlLabel = document.createElement("label");
  const urlInput = document.createElement("input");
  const validationMessage = document.createElement("p");
  const titleSuggestionStatus = document.createElement("p");
  const addButton = document.createElement("button");
  let titleWasManuallyEdited = false;
  let titleRequestId = 0;

  form.className = "new-lesson-form";
  titleLabel.htmlFor = "newLessonTitle";
  titleLabel.textContent = "Lesson title";
  titleInput.id = "newLessonTitle";
  titleInput.name = "title";
  titleInput.required = true;
  titleInput.maxLength = 100;
  titleInput.autocomplete = "off";
  urlLabel.htmlFor = "newLessonUrl";
  urlLabel.textContent = "YouTube or direct video URL";
  urlInput.id = "newLessonUrl";
  urlInput.name = "url";
  urlInput.type = "url";
  urlInput.required = true;
  urlInput.placeholder = "https://...";
  urlInput.autocomplete = "url";
  validationMessage.className = "new-lesson-validation";
  validationMessage.setAttribute("role", "status");
  titleSuggestionStatus.className = "title-suggestion-status";
  titleSuggestionStatus.setAttribute("role", "status");
  titleSuggestionStatus.setAttribute("aria-live", "polite");
  addButton.type = "submit";
  addButton.className = "new-lesson-submit";
  addButton.append(createEditorIcon("check"), document.createTextNode("Add lesson"));

  const validate = () => {
    const parsed = parseVideoUrl(urlInput.value);
    const titleIsValid = titleInput.value.trim().length > 0;
    const urlIsValid = !parsed.error;
    addButton.disabled = !titleIsValid || !urlIsValid;
    validationMessage.textContent = parsed.error ?? "";
    urlInput.setAttribute("aria-invalid", String(!urlIsValid && urlInput.value.length > 0));
  };
  titleInput.addEventListener("input", () => {
    titleWasManuallyEdited = true;
    titleSuggestionStatus.textContent = "Title entered manually.";
    validate();
  });
  urlInput.addEventListener("input", () => {
    validate();
    suggestVideoTitle();
  });

  function suggestVideoTitle() {
    const requestId = ++titleRequestId;
    if (titleWasManuallyEdited) {
      return;
    }

    const parsed = parseVideoUrl(urlInput.value);
    if (parsed.error) {
      titleInput.value = "";
      titleSuggestionStatus.textContent = "";
      validate();
      return;
    }

    if (parsed.lesson.type === "video") {
      titleInput.value = getVideoFilenameTitle(parsed.lesson.src);
      titleSuggestionStatus.textContent = "Suggested from the video filename. You can edit it.";
      validate();
      return;
    }

    titleInput.value = `YouTube video ${parsed.lesson.videoId}`;
    titleSuggestionStatus.textContent = "Looking up the YouTube title…";
    validate();
    fetch(`/api/video-title?videoId=${encodeURIComponent(parsed.lesson.videoId)}`)
      .then(async (response) => {
        const result = await readApiJson(response, "YouTube title lookup");
        if (!response.ok) {
          throw new Error(result.error ?? `Title lookup failed (${response.status}).`);
        }
        return result;
      })
      .then((result) => {
        if (requestId !== titleRequestId || titleWasManuallyEdited) {
          return;
        }
        if (typeof result.title !== "string" || !result.title.trim()) {
          throw new Error("YouTube did not return a video title.");
        }
        titleInput.value = result.title.trim();
        titleSuggestionStatus.textContent = "Suggested from YouTube. You can edit it.";
        validate();
      })
      .catch((error) => {
        if (requestId !== titleRequestId || titleWasManuallyEdited) {
          return;
        }
        const message = error instanceof Error ? error.message : "Unknown lookup error.";
        titleSuggestionStatus.textContent =
          `Could not retrieve the YouTube title: ${message} Edit the suggested title as needed.`;
      });
  }

  validate();
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    validate();
    if (addButton.disabled) {
      return;
    }

    const parsed = parseVideoUrl(urlInput.value);
    let nextLessonId = Math.max(
      Date.now(),
      ...modules.map((module) => module.id),
      ...removedLessonIds
    );
    while (modules.some((module) => module.id === nextLessonId)) {
      nextLessonId += 1;
    }
    const lesson = {
      id: nextLessonId,
      title: titleInput.value.trim(),
      ...parsed.lesson
    };
    modules.push(lesson);
    newlyAddedLessonIds.add(nextLessonId);
    const emptyActivities = { quizzes: [], reflections: [] };
    catalogActivities.set(nextLessonId, emptyActivities);
    lessonActivities.set(nextLessonId, emptyActivities);
    progress.activityDecks[nextLessonId] = {
      quizOrder: [],
      quizRevealCount: 0,
      reflectionOrder: [],
      reflectionRevealCount: 0
    };
    course.lessons = modules;
    showAddLessonForm = false;
    renderModuleList();
    saveStatus.textContent = `"${lesson.title}" was added. Select the check mark to save the course changes.`;
    saveStatus.classList.remove("save-status--error");
  });

  form.append(
    titleLabel,
    titleInput,
    titleSuggestionStatus,
    urlLabel,
    urlInput,
    validationMessage,
    addButton
  );
  list.appendChild(form);
}

function playbackMediaKey(lesson) {
  return lesson.type === "youtube"
    ? `youtube:${lesson.videoId}`
    : `video:${lesson.src}`;
}

function playbackStorageKey(lesson) {
  return `learningPlatformPlayback:${lesson.id}`;
}

function reportPlaybackError(message) {
  saveStatus.textContent = message;
  saveStatus.classList.add("save-status--error");
}

function readLocalPlaybackPosition(lesson) {
  try {
    const stored = localStorage.getItem(playbackStorageKey(lesson));
    if (!stored) {
      return null;
    }
    const position = JSON.parse(stored);
    if (
      !position ||
      position.mediaKey !== playbackMediaKey(lesson) ||
      !Number.isFinite(position.positionSeconds) ||
      position.positionSeconds < 0 ||
      !Number.isFinite(position.updatedAt)
    ) {
      return null;
    }
    return position;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown storage error.";
    reportPlaybackError(`Local playback position could not be read: ${message}`);
    return null;
  }
}

function writeLocalPlaybackPosition(lesson, positionSeconds, updatedAt) {
  try {
    localStorage.setItem(
      playbackStorageKey(lesson),
      JSON.stringify({
        mediaKey: playbackMediaKey(lesson),
        positionSeconds,
        updatedAt
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown storage error.";
    reportPlaybackError(`Playback position could not be saved in this browser: ${message}`);
  }
}

async function loadPlaybackPosition(lesson) {
  const localPosition = readLocalPlaybackPosition(lesson);
  try {
    const response = await fetch(
      `/api/playback-position?lessonId=${encodeURIComponent(lesson.id)}`,
      { cache: "no-store" }
    );
    const result = await readApiJson(response, "Playback position");
    if (!response.ok) {
      throw new Error(result.error ?? `Playback position failed (${response.status}).`);
    }
    const saved = result.position;
    const serverPosition =
      saved &&
      Number.isFinite(saved.positionSeconds) &&
      saved.positionSeconds >= 0 &&
      Number.isFinite(saved.updatedAt)
        ? {
            positionSeconds: saved.positionSeconds,
            updatedAt: saved.updatedAt
          }
        : null;
    if (
      localPosition &&
      (!serverPosition || localPosition.updatedAt > serverPosition.updatedAt)
    ) {
      void savePlaybackPositionForLesson(
        lesson,
        localPosition.positionSeconds
      );
      return localPosition;
    }
    if (serverPosition) {
      writeLocalPlaybackPosition(
        lesson,
        serverPosition.positionSeconds,
        serverPosition.updatedAt
      );
    }
    return serverPosition;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    reportPlaybackError(
      `Playback position could not be loaded from SQLite: ${message}`
    );
    return localPosition;
  }
}

async function savePlaybackPositionForLesson(
  lesson,
  positionSeconds,
  { keepalive = false } = {}
) {
  if (!Number.isFinite(positionSeconds) || positionSeconds < 0) {
    return false;
  }
  const updatedAt = Date.now() / 1000;
  writeLocalPlaybackPosition(lesson, positionSeconds, updatedAt);
  if (playbackPositionRequests.has(lesson.id) && !keepalive) {
    return playbackPositionRequests.get(lesson.id);
  }

  const request = (async () => {
    try {
      const response = await fetch("/api/playback-position", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lessonId: lesson.id,
          positionSeconds
        }),
        keepalive
      });
      const result = await readApiJson(response, "Playback position");
      if (!response.ok) {
        throw new Error(result.error ?? `Playback position failed (${response.status}).`);
      }
      if (
        result.position?.lessonId !== lesson.id ||
        !Number.isFinite(result.position.positionSeconds) ||
        !Number.isFinite(result.position.updatedAt)
      ) {
        throw new Error("The server returned an invalid playback position.");
      }
      const latestLocalPosition = readLocalPlaybackPosition(lesson);
      if (
        !latestLocalPosition ||
        latestLocalPosition.updatedAt <= result.position.updatedAt
      ) {
        writeLocalPlaybackPosition(
          lesson,
          result.position.positionSeconds,
          result.position.updatedAt
        );
      }
      if (saveStatus.textContent.startsWith("Playback position could not")) {
        saveStatus.textContent = "Playback position saved to SQLite.";
        saveStatus.classList.remove("save-status--error");
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown server error.";
      reportPlaybackError(`Playback position could not be saved to SQLite: ${message}`);
      return false;
    } finally {
      if (playbackPositionRequests.get(lesson.id) === request) {
        playbackPositionRequests.delete(lesson.id);
      }
    }
  })();
  playbackPositionRequests.set(lesson.id, request);
  return request;
}

function saveCurrentPlaybackPosition(options) {
  const lesson = modules[currentModule];
  if (!lesson) {
    return Promise.resolve(false);
  }
  if (
    lesson.type === "youtube" &&
    youtubePlayer &&
    youtubePlayerLessonId === lesson.id
  ) {
    try {
      const positionSeconds = youtubePlayer.getCurrentTime();
      return savePlaybackPositionForLesson(lesson, positionSeconds, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown player error.";
      reportPlaybackError(`Playback position could not be read: ${message}`);
      return Promise.resolve(false);
    }
  }
  const video = document.querySelector("#playerContainer video");
  if (lesson.type === "video" && video) {
    return savePlaybackPositionForLesson(lesson, video.currentTime, options);
  }
  return Promise.resolve(false);
}

function startPlaybackSaveTimer() {
  window.clearInterval(playbackSaveTimer);
  playbackSaveTimer = window.setInterval(() => {
    void saveCurrentPlaybackPosition();
  }, 10000);
}

function destroyCurrentPlayer() {
  youtubePlayerGeneration += 1;
  window.clearInterval(playbackSaveTimer);
  playbackSaveTimer = null;
  const previousPlayer = youtubePlayer;
  youtubePlayer = null;
  youtubePlayerLessonId = null;
  youtubePlayerReadyPromise = null;
  if (previousPlayer) {
    previousPlayer.destroy();
  }
}

function loadYouTubeIframeApi() {
  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }
  if (youtubeApiPromise) {
    return youtubeApiPromise;
  }
  const pending = new Promise((resolve, reject) => {
    const previousCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (window.YT?.Player) {
        try {
          if (typeof previousCallback === "function") {
            previousCallback();
          }
          resolve(window.YT);
        } catch (error) {
          reject(error);
        }
      } else {
        reject(new Error("YouTube player controls did not load."));
      }
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => reject(new Error("YouTube player controls could not load."));
    document.head.appendChild(script);
  });
  youtubeApiPromise = pending.catch((error) => {
    youtubeApiPromise = null;
    throw error;
  });
  return youtubeApiPromise;
}

function attachYouTubePlayer(iframe, lesson, generation) {
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  youtubePlayerReadyPromise = ready;
  youtubePlayerLessonId = lesson.id;
  loadYouTubeIframeApi()
    .then((api) => {
      if (generation !== youtubePlayerGeneration || !iframe.isConnected) {
        resolveReady(null);
        return;
      }
      new api.Player(iframe, {
        playerVars: {
          autoplay: 0
        },
        events: {
          onReady: async (event) => {
            if (generation !== youtubePlayerGeneration) {
              event.target.destroy();
              return;
            }
            youtubePlayer = event.target;
            startPlaybackSaveTimer();
            try {
              const saved = await loadPlaybackPosition(lesson);
              if (
                generation === youtubePlayerGeneration &&
                saved &&
                saved.positionSeconds > 0
              ) {
                event.target.seekTo(saved.positionSeconds, true);
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : "Unknown player error.";
              reportPlaybackError(`Playback could not be resumed: ${message}`);
            }
            resolveReady(event.target);
          },
          onStateChange: (event) => {
            if (generation !== youtubePlayerGeneration) {
              return;
            }
            if (event.data === api.PlayerState.PAUSED) {
              void saveCurrentPlaybackPosition();
            } else if (event.data === api.PlayerState.ENDED) {
              void savePlaybackPositionForLesson(lesson, 0);
            }
          },
          onError: (event) => {
            const error = new Error(`YouTube player error (${event.data}).`);
            reportPlaybackError(error.message);
            rejectReady(error);
          }
        }
      });
    })
    .catch(rejectReady);
  return ready;
}

async function seekToVideoTimestamp(lesson, timestampSeconds) {
  if (
    lesson?.type !== "youtube" ||
    !Number.isFinite(timestampSeconds) ||
    timestampSeconds < 0
  ) {
    return;
  }
  try {
    if (youtubePlayerLessonId !== lesson.id || !youtubePlayerReadyPromise) {
      throw new Error("The embedded video is not ready yet.");
    }
    const player = await youtubePlayerReadyPromise;
    if (youtubePlayerLessonId !== lesson.id) {
      throw new Error("The selected video changed before it was ready.");
    }
    player.seekTo(timestampSeconds, true);
    player.pauseVideo();
    void savePlaybackPositionForLesson(lesson, timestampSeconds);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown player error.";
    reportPlaybackError(`The video could not seek to this topic: ${message}`);
  }
}

function renderPlayer(lesson) {
  destroyCurrentPlayer();
  const container = document.getElementById("playerContainer");
  container.replaceChildren();

  if (lesson.type === "youtube") {
    const iframe = document.createElement("iframe");
    const url = new URL(
      `https://www.youtube.com/embed/${encodeURIComponent(lesson.videoId)}`
    );
    url.searchParams.set("enablejsapi", "1");
    url.searchParams.set("origin", window.location.origin);
    url.searchParams.set("autoplay", "0");
    iframe.src = url.toString();
    iframe.title = `${lesson.title} video`;
    iframe.allow =
      "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    iframe.allowFullscreen = true;
    container.appendChild(iframe);
    const generation = youtubePlayerGeneration;
    void attachYouTubePlayer(iframe, lesson, generation).catch((error) => {
      const message = error instanceof Error ? error.message : "Unknown player error.";
      reportPlaybackError(`YouTube player could not be prepared: ${message}`);
    });
    return;
  }

  const video = document.createElement("video");
  const source = document.createElement("source");
  video.controls = true;
  video.autoplay = false;
  source.src = lesson.src;
  source.type = "video/mp4";
  video.appendChild(source);
  video.addEventListener("loadedmetadata", () => {
    void loadPlaybackPosition(lesson).then((saved) => {
      if (
        saved &&
        Number.isFinite(video.duration) &&
        video.duration > 0 &&
        video.currentTime === 0
      ) {
        video.currentTime = Math.max(
          0,
          Math.min(saved.positionSeconds, video.duration - 0.25)
        );
      }
    });
  });
  video.addEventListener("pause", () => {
    void savePlaybackPositionForLesson(
      lesson,
      video.ended ? 0 : video.currentTime
    );
  });
  video.addEventListener("ended", () => {
    void savePlaybackPositionForLesson(lesson, 0);
  });
  container.appendChild(video);
  startPlaybackSaveTimer();
}

function renderQuiz(quiz, lessonProgress, lessonId, index, container) {
  const fieldset = document.createElement("fieldset");
  const legend = document.createElement("legend");
  const feedback = document.createElement("p");
  const quizSection = document.createElement("section");
  const selectedAnswer = lessonProgress.quizAnswers[quiz.id] ?? null;

  quizSection.className = "activity-card";
  quizSection.setAttribute("aria-labelledby", `quiz-title-${lessonId}-${quiz.id}`);
  fieldset.className = "quiz-options";
  legend.id = `quiz-title-${lessonId}-${quiz.id}`;
  legend.textContent = quiz.question;
  fieldset.appendChild(legend);

  quiz.options.forEach((option, optionIndex) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = `quiz-${lessonId}-${quiz.id}`;
    input.value = String(optionIndex);
    input.checked = selectedAnswer === optionIndex;
    input.addEventListener("change", () => {
      lessonProgress.quizAnswers[quiz.id] = optionIndex;
      persistProgress("Quiz answer saved.");
      renderModuleList();
      const isCorrect = optionIndex === quiz.answer;
      feedback.className = isCorrect ? "quiz-feedback quiz-feedback--correct" : "quiz-feedback";
      feedback.setAttribute("role", "status");
      feedback.textContent = isCorrect
        ? `Correct. ${quiz.feedback}`
        : "Not quite. Review the lesson and try another answer.";
      updateCompletionRequirements(index);
    });
    label.append(input, document.createTextNode(option));
    fieldset.appendChild(label);
  });

  if (selectedAnswer !== null) {
    const isCorrect = selectedAnswer === quiz.answer;
    feedback.className = isCorrect ? "quiz-feedback quiz-feedback--correct" : "quiz-feedback";
    feedback.setAttribute("role", "status");
    feedback.textContent = isCorrect
      ? `Correct. ${quiz.feedback}`
      : `Not quite. Review the lesson and try another answer.`;
  } else {
    feedback.className = "quiz-feedback";
    feedback.textContent = "Choose an answer to check your understanding.";
  }

  quizSection.append(fieldset, feedback);
  container.appendChild(quizSection);
}

function renderQuizRevealControl(index, shownCount, totalCount, container) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "reveal-activities-button quiz-reveal-button";
  const isFullyRevealed = shownCount >= totalCount;
  const isExpanded = shownCount > Math.min(2, totalCount);
  button.setAttribute(
    "aria-label",
    isFullyRevealed ? "Show fewer quiz questions" : "Show more quiz questions"
  );
  button.setAttribute("aria-expanded", String(isExpanded));
  const chevron = document.createElement("span");
  chevron.className = "reveal-activities-chevron";
  chevron.classList.toggle("reveal-activities-chevron--up", isFullyRevealed);
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "⌄";
  button.appendChild(chevron);
  button.addEventListener("click", () => {
    flushPendingReflectionSave();
    const deck = progress.activityDecks[modules[index].id];
    deck.quizRevealCount = isFullyRevealed
      ? Math.max(Math.min(2, totalCount), deck.quizRevealCount - 2)
      : Math.min(deck.quizRevealCount + 2, totalCount);
    currentActivities = selectActivities(index);
    persistProgress();
    renderActivities(index);
    document.querySelector(".quiz-reveal-button")?.focus();
  });
  container.appendChild(button);
}

function renderReflectionRevealControl(index, shownCount, totalCount, container) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "reveal-activities-button reflection-reveal-button";
  const isFullyRevealed = shownCount >= totalCount;
  const isExpanded = shownCount > Math.min(1, totalCount);
  button.setAttribute(
    "aria-label",
    isFullyRevealed ? "Show fewer reflections" : "Show more reflections"
  );
  button.setAttribute("aria-expanded", String(isExpanded));
  const chevron = document.createElement("span");
  chevron.className = "reveal-activities-chevron";
  chevron.classList.toggle("reveal-activities-chevron--up", isFullyRevealed);
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "⌄";
  button.appendChild(chevron);
  button.addEventListener("click", () => {
    flushPendingReflectionSave();
    const deck = progress.activityDecks[modules[index].id];
    deck.reflectionRevealCount = isFullyRevealed
      ? Math.max(Math.min(1, totalCount), deck.reflectionRevealCount - 1)
      : Math.min(deck.reflectionRevealCount + 1, totalCount);
    currentActivities = selectActivities(index);
    persistProgress();
    renderActivities(index);
    document.querySelector(".reflection-reveal-button")?.focus();
  });
  container.appendChild(button);
}

function renderReflection(reflection, lessonProgress, lessonId, index, container) {
  const section = document.createElement("section");
  const label = document.createElement("label");
  const textarea = document.createElement("textarea");
  const saveStatusMessage = document.createElement("p");
  const reflectionId = `reflection-${lessonId}-${reflection.id}`;
  const savedReflection = lessonProgress.reflections[reflection.id] ?? "";
  const hasSavedReflection = Object.hasOwn(lessonProgress.reflections, reflection.id);

  section.className = "activity-card reflection-card";
  label.className = "activity-heading";
  label.htmlFor = reflectionId;
  label.textContent = reflection.prompt;
  textarea.id = reflectionId;
  textarea.rows = 4;
  textarea.value = savedReflection;
  textarea.placeholder = "Write a response for yourself...";
  saveStatusMessage.className = "activity-save-status";
  saveStatusMessage.setAttribute("role", "status");
  saveStatusMessage.setAttribute("aria-live", "polite");
  saveStatusMessage.textContent = hasSavedReflection
    ? "Saved automatically."
    : "Changes save automatically to SQLite.";
  textarea.addEventListener("input", () => {
    lessonProgress.reflections[reflection.id] = textarea.value;
    saveStatusMessage.textContent = "Saving…";
    saveStatusMessage.classList.remove("activity-save-status--error");

    const statuses = pendingReflectionSave?.statuses ?? new Set();
    statuses.add(saveStatusMessage);
    if (pendingReflectionSave) {
      clearTimeout(pendingReflectionSave.timer);
    }

    const timer = window.setTimeout(() => {
      void flushPendingReflectionSave();
    }, 400);
    pendingReflectionSave = { timer, statuses };
    updateCompletionRequirements(index);
  });
  textarea.addEventListener("blur", flushPendingReflectionSave);

  section.append(label, textarea, saveStatusMessage);
  container.appendChild(section);
}

function renderCompletion(module, lessonProgress, index) {
  const section = document.createElement("section");
  const requirements = document.createElement("p");
  const reattemptButton = document.createElement("button");
  const actions = document.createElement("div");
  const completionButton = document.createElement("button");
  section.className = "completion-row";
  requirements.id = "completionRequirements";
  requirements.className = "completion-requirements";
  reattemptButton.type = "button";
  reattemptButton.className = "secondary-button";
  reattemptButton.textContent = "Re-attempt";
  const generationState = activityGenerationStates.get(module.id);
  reattemptButton.disabled =
    !currentActivities ||
    generationState?.state === "queued" ||
    generationState?.state === "processing";
  reattemptButton.addEventListener("click", () => reattemptLesson(index));

  actions.className = "completion-actions";
  completionButton.type = "button";
  completionButton.className = "completion-button";
  completionButton.textContent = lessonProgress.completed
    ? "Mark as incomplete"
    : "Mark lesson complete";
  completionButton.setAttribute("aria-pressed", String(lessonProgress.completed));
  completionButton.addEventListener("click", () => {
    if (!lessonProgress.completed && !getCompletionRequirements(index).isComplete) {
      updateCompletionRequirements(index);
      return;
    }

    lessonProgress.completed = !lessonProgress.completed;
    persistProgress(
      lessonProgress.completed ? "Lesson marked complete." : "Lesson marked incomplete."
    );
    renderModuleList();
    renderActivities(index);
  });
  completionButton.disabled =
    !lessonProgress.completed && !getCompletionRequirements(index).isComplete;

  actions.appendChild(completionButton);
  if (lessonProgress.completed && index < modules.length - 1) {
    const nextVideoButton = document.createElement("button");
    nextVideoButton.type = "button";
    nextVideoButton.className = "next-video-button";
    nextVideoButton.textContent = "Next Video";
    nextVideoButton.addEventListener("click", () => loadModule(index + 1));
    actions.appendChild(nextVideoButton);
  }

  section.append(requirements, reattemptButton, actions);
  activities.appendChild(section);
  updateCompletionRequirements(index);
}

async function reattemptLesson(index) {
  const module = modules[index];
  const activity = lessonActivities.get(module.id);
  if (
    !activity ||
    !Array.isArray(activity.quizzes) ||
    !Array.isArray(activity.reflections) ||
    activity.quizzes.length === 0 ||
    activity.reflections.length === 0
  ) {
    return;
  }

  const confirmed = window.confirm(
    "Re-attempt this lesson? The quiz questions and reflection will change, and all saved quiz answers and reflection responses for this lesson will be deleted."
  );
  if (!confirmed) {
    return;
  }

  await flushPendingReflectionSave();
  activityGenerationStates.set(module.id, {
    state: "processing",
    mode: "reattempt"
  });
  activityAttempts.delete(module.id);
  lessonActivities.set(module.id, { quizzes: [], reflections: [] });
  const lessonIndex = progress.lessonIds.indexOf(module.id);
  if (lessonIndex >= 0) {
    progress.lessons[lessonIndex] = {
      quizAnswers: {},
      reflections: {},
      completed: false
    };
  }
  progress.activityDecks[module.id] = {
    quizOrder: [],
    quizRevealCount: 0,
    reflectionOrder: [],
    reflectionRevealCount: 0
  };
  currentActivities = { quizzes: [], reflections: [] };
  activities.replaceChildren();
  const preparing = document.createElement("p");
  preparing.className = "activity-attempt-status";
  preparing.setAttribute("role", "status");
  preparing.textContent = "Generating a new activity set locally…";
  activities.appendChild(preparing);
  renderModuleList();

  try {
    const response = await fetch("/api/activity-attempt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lessonId: module.id, mode: "reattempt" })
    });
    const result = await readApiJson(response, "New activity attempt");
    if (!response.ok) {
      throw new Error(result.error ?? `New attempt failed (${response.status}).`);
    }

    if (result.attempt) {
      updateActivityAttempt(module.id, result.attempt, true);
    }
    if (result.generationState?.status === "failed") {
      activityGenerationStates.set(module.id, {
        state: "failed",
        mode: "reattempt",
        message: `New questions could not be prepared: ${result.generationState.failureReason || "Generation failed."}`
      });
    } else if (result.attempt) {
      activityGenerationStates.set(module.id, { state: "ready" });
    } else {
      throw new Error("The server returned no questions and no generation status.");
    }
    if (modules[currentModule]?.id === module.id) {
      currentActivities = selectActivities(currentModule);
      renderActivities(currentModule);
    }
    if (result.attempt) {
      const saved = await persistProgress(
        "New attempt started. This lesson's previous responses were cleared."
      );
      if (!saved.ok) {
        saveStatus.textContent = saved.message;
        saveStatus.classList.add("save-status--error");
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    activityGenerationStates.set(module.id, {
      state: "failed",
      mode: "reattempt",
      message: `New questions could not be prepared: ${message}`
    });
    saveStatus.textContent = `A new attempt could not be started: ${message}`;
    saveStatus.classList.add("save-status--error");
    if (modules[currentModule]?.id === module.id) {
      currentActivities = selectActivities(currentModule);
      renderActivities(currentModule);
    }
  }
}

function renderActivities(index) {
  const module = modules[index];
  const lessonProgress = getLessonProgress(index);
  activities.replaceChildren();

  if (!currentActivities) {
    activityDataError = true;
    saveStatus.textContent = `Activities could not be loaded for "${module.title}". Check the SQLite course data for lesson ID ${module.id}.`;
    saveStatus.classList.add("save-status--error");
    const errorMessage = document.createElement("p");
    errorMessage.className = "save-status save-status--error";
    errorMessage.textContent = "The activities for this lesson are unavailable.";
    activities.appendChild(errorMessage);
    renderCompletion(module, lessonProgress, index);
    return;
  }

  if (activityDataError) {
    if (saveStatus.textContent.startsWith("Activities could not be loaded for ")) {
      saveStatus.textContent = "";
      saveStatus.classList.remove("save-status--error");
    }
    activityDataError = false;
  }

  const attempt = activityAttempts.get(module.id);
  const generationState = activityGenerationStates.get(module.id);
  const attemptStatus = document.createElement("p");
  attemptStatus.className = "activity-attempt-status";
  attemptStatus.setAttribute("role", "status");
  if (generationState?.state === "queued") {
    attemptStatus.textContent =
      "Questions are queued for this video.";
  } else if (generationState?.state === "processing") {
    attemptStatus.textContent =
      "Questions are being processed for this video.";
  } else if (generationState?.state === "waiting-to-save") {
    attemptStatus.textContent = generationState.message;
  } else if (generationState?.state === "preserved") {
    attemptStatus.textContent = generationState.message;
  } else if (generationState?.state === "failed") {
    attemptStatus.classList.add("activity-attempt-status--fallback");
    attemptStatus.textContent = generationState.message;
  } else if (attempt?.source === "generated") {
    attemptStatus.textContent =
      attempt.generationDurationSeconds === null ||
      attempt.generationDurationSeconds === undefined
        ? "Questions generated; processing time is unavailable for this saved attempt."
        : `Questions generated in ${formatGenerationDuration(attempt.generationDurationSeconds)}.`;
  } else if (attempt?.source === "fallback") {
    attemptStatus.classList.add("activity-attempt-status--fallback");
    const elapsed = Number.isFinite(attempt.generationDurationSeconds)
      ? ` Processing took ${formatGenerationDuration(attempt.generationDurationSeconds)}.`
      : "";
    attemptStatus.textContent = `Saved lesson activities are shown as a fallback.${elapsed} ${attempt.failureReason || "Local generation was unavailable."}`;
  } else {
    attemptStatus.textContent = "Saved lesson activities.";
  }
  activities.appendChild(attemptStatus);
  if (generationState?.state === "failed") {
    renderGenerationRetryButton(module.id);
  }

  const allActivities = lessonActivities.get(module.id);
  if (
    currentActivities.quizzes.length === 0 &&
    currentActivities.reflections.length === 0
  ) {
    return;
  }

  const quizGroup = document.createElement("section");
  const quizHeading = document.createElement("h3");
  const quizList = document.createElement("div");
  quizGroup.className = "activity-group";
  quizHeading.className = "activity-group-heading";
  quizHeading.textContent = "Pop Quiz";
  quizList.className = "activity-group-list";
  quizGroup.append(quizHeading, quizList);
  activities.appendChild(quizGroup);
  currentActivities.quizzes.forEach((quiz) =>
    renderQuiz(quiz, lessonProgress, module.id, index, quizList)
  );
  renderQuizRevealControl(
    index,
    currentActivities.quizzes.length,
    allActivities.quizzes.length,
    quizList
  );
  const reflectionGroup = document.createElement("section");
  const reflectionHeading = document.createElement("h3");
  const reflectionList = document.createElement("div");
  reflectionGroup.className = "activity-group";
  reflectionHeading.className = "activity-group-heading";
  reflectionHeading.textContent = "Short Answers";
  reflectionList.className = "activity-group-list";
  reflectionGroup.append(reflectionHeading, reflectionList);
  activities.appendChild(reflectionGroup);
  currentActivities.reflections.forEach((reflection) =>
    renderReflection(reflection, lessonProgress, module.id, index, reflectionList)
  );
  renderReflectionRevealControl(
    index,
    currentActivities.reflections.length,
    allActivities.reflections.length,
    reflectionList
  );
  renderCompletion(module, lessonProgress, index);
  if (
    generationState?.state === "queued" ||
    generationState?.state === "processing"
  ) {
    activities
      .querySelectorAll("input, textarea, .reveal-activities-button")
      .forEach((control) => {
        control.disabled = true;
      });
  }
}

function renderGenerationRetryButton(lessonId) {
  const retryButton = document.createElement("button");
  retryButton.type = "button";
  retryButton.className = "secondary-button";
  retryButton.textContent = "Retry question generation";
  retryButton.addEventListener("click", () => retryLessonGeneration(lessonId));
  activities.appendChild(retryButton);
}

function formatGenerationDuration(seconds) {
  const totalSeconds = Math.max(0, Math.round(seconds));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function loadModule(i, shouldPersist = true) {
  if (!Number.isInteger(i) || i < 0 || i >= modules.length) {
    saveStatus.textContent = "That lesson is unavailable.";
    saveStatus.classList.add("save-status--error");
    return;
  }

  cancelVideoExplanation();
  flushPendingReflectionSave();
  const activeVideo = document.querySelector("#playerContainer video");
  if (youtubePlayer || activeVideo) {
    void saveCurrentPlaybackPosition();
  }
  activeVideo?.pause();
  currentModule = i;
  progress.currentModule = i;
  currentActivities = selectActivities(i);
  const viewMode = lessonViewModes.get(modules[i].id) ?? "video";
  lessonViewModes.set(modules[i].id, viewMode);
  const showingActivities = viewMode === "activities";
  videoView.hidden = showingActivities;
  testKnowledgeButton.hidden = showingActivities;
  activitiesView.hidden = !showingActivities;
  testKnowledgeButton.setAttribute("aria-expanded", String(showingActivities));
  backToVideoButton.setAttribute("aria-expanded", String(!showingActivities));
  document.getElementById("previousButton").disabled = i === 0;
  document.getElementById("nextButton").disabled = i === modules.length - 1;
  renderModuleList();

  const m = modules[i];
  if (progress && !editingLessons) {
    progress.currentModuleId = m.id;
  }
  renderPlayer(m);
  if (showingActivities) {
    const iframe = document.querySelector("#playerContainer iframe");
    if (iframe) {
      iframe.src = "about:blank";
    }
    document.querySelector("#playerContainer video")?.pause();
    destroyCurrentPlayer();
  }
  title.textContent = m.title;
  renderVideoExplainer(m);
  renderVideoDetails(m, true);
  renderActivities(i);
  if (shouldPersist && currentActivities && !editingLessons) {
    persistProgress();
  }
}

function nextLesson() {
  if (currentModule < modules.length - 1) {
    loadModule(currentModule + 1);
  }
}

function previousLesson() {
  if (currentModule > 0) {
    loadModule(currentModule - 1);
  }
}

async function initializeCourse() {
  let migrationError = "";
  try {
    const query = new URLSearchParams(window.location.search);
    const courseId = query.get("courseId");
    currentCourseId = courseId ? Number(courseId) : 1;
    const response = await fetch(
      `/api/catalog${courseId ? `?courseId=${encodeURIComponent(courseId)}` : ""}`,
      { cache: "no-store" }
    );
    const result = await readApiJson(response, "Course load");
    if (!response.ok) {
      throw new Error(result.error ?? `Course request failed (${response.status}).`);
    }
    if (!result.catalog) {
      throw new Error("The SQLite course database does not contain a course.");
    }

    applyCatalog(result.catalog);
    if (modules.length === 0) {
      progress = createEmptyProgress(modules);
      currentModule = 0;
      editingLessons = true;
      forcedEmptyCourseEditor = true;
      showAddLessonForm = true;
      videoView.hidden = true;
      videoDetails.hidden = true;
      testKnowledgeButton.hidden = true;
      activitiesView.hidden = true;
      renderModuleList();
      saveStatus.textContent =
        "Add a video lesson to this new course, then select the check mark to save it.";
      return;
    }
    applyActivityAttempts(result.attempts);
    applyActivityGenerationStates(result.generationStates ?? {});
    if (result.progress) {
      progress = reconcileProgress(result.progress, modules, lessonActivities);
      const cleanup = clearLegacyProgress();
      if (!cleanup.ok) {
        migrationError = cleanup.message;
      }
    } else {
      const legacyProgress = loadProgress(modules, lessonActivities);
      if (legacyProgress.error) {
        progress = legacyProgress;
        progressMigrationBlocked = true;
        migrationError = legacyProgress.error;
      } else {
        try {
          const importResponse = await fetch("/api/progress/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(legacyProgress)
          });
          const imported = await readApiJson(importResponse, "Progress migration");
          if (!importResponse.ok) {
            throw new Error(
              imported.error ?? `Progress migration failed (${importResponse.status}).`
            );
          }
          progress = imported.imported
            ? legacyProgress
            : reconcileProgress(imported.progress, modules, lessonActivities);
          const cleanup = clearLegacyProgress();
          if (!cleanup.ok) {
            migrationError = cleanup.message;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown server error.";
          progress = legacyProgress;
          progressMigrationBlocked = true;
          migrationError = `Learner progress could not be migrated to SQLite: ${message}`;
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    saveStatus.textContent = `Course data could not be loaded from SQLite: ${message}`;
    saveStatus.classList.add("save-status--error");
    return;
  }

  currentModule = progress.currentModule;
  loadModule(currentModule, false);
  videoDetailsStartupPromise = ensureVideoDetailsForLessons(modules);
  await videoDetailsStartupPromise;
  if (!progressMigrationBlocked && currentActivities) {
    await persistProgress("Progress saved to SQLite.");
  }
  if (migrationError || progress.error) {
    saveStatus.textContent = migrationError || progress.error;
    saveStatus.classList.add("save-status--error");
  }
  if (window.themePreferenceError) {
    saveStatus.textContent =
      `The saved theme preference could not be loaded: ${window.themePreferenceError}`;
    saveStatus.classList.add("save-status--error");
  }
  if (!progressMigrationBlocked) {
    activityGenerationStates.forEach((state, lessonId) => {
      if (state.state === "resume-pending") {
        enqueueLessonGeneration(lessonId);
      }
    });
    queueEligibleLessons();
  }
}

initializeCourse();
