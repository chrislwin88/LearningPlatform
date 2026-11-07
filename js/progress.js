const PROGRESS_STORAGE_KEY = "learningPlatformProgress";
const PROGRESS_VERSION = 4;
let progressSaveQueue = Promise.resolve();

function createEmptyProgress(courseModules) {
  const activityDecks = {};

  courseModules.forEach((module) => {
    activityDecks[module.id] = {
      quizOrder: [],
      quizRevealCount: 2,
      reflectionOrder: [],
      reflectionRevealCount: 1
    };
  });

  return {
    version: PROGRESS_VERSION,
    currentModule: 0,
    currentModuleId: courseModules[0]?.id ?? null,
    lessonIds: courseModules.map((module) => module.id),
    lessons: courseModules.map(() => ({
      quizAnswers: {},
      reflections: {},
      completed: false
    })),
    activityDecks
  };
}

function normalizeSavedResponses(savedResponses, activityItems, responseType) {
  if (
    savedResponses === null ||
    typeof savedResponses !== "object" ||
    Array.isArray(savedResponses)
  ) {
    return {};
  }

  const validItems = new Map(activityItems.map((item) => [item.id, item]));
  const responses = {};

  Object.entries(savedResponses).forEach(([itemId, response]) => {
    const item = validItems.get(itemId);
    if (!item) {
      return;
    }

    if (
      responseType === "quiz" &&
      Number.isInteger(response) &&
      response >= 0 &&
      response < item.options.length
    ) {
      responses[itemId] = response;
    } else if (responseType === "reflection" && typeof response === "string") {
      responses[itemId] = response;
    }
  });

  return responses;
}

function normalizeOrder(savedOrder, items, legacySelectedId, legacyRemaining) {
  const validIds = new Set(items.map((item) => item.id));
  const requestedOrder = Array.isArray(savedOrder)
    ? savedOrder
    : [legacySelectedId, ...(Array.isArray(legacyRemaining) ? legacyRemaining : [])];
  const order = [...new Set(requestedOrder.filter((id) => validIds.has(id)))];
  items.forEach((item) => {
    if (!order.includes(item.id)) {
      order.push(item.id);
    }
  });
  return order;
}

function normalizeRevealCount(savedCount, items, order, minimum, responses, responseType) {
  const requestedCount = Number.isInteger(savedCount) ? savedCount : minimum;
  const count = Math.min(Math.max(requestedCount, minimum), items.length);
  const responseIds = Object.keys(responses).filter((itemId) => {
    const response = responses[itemId];
    return responseType === "quiz" || response.trim().length > 0;
  });
  const lastSavedResponseIndex = responseIds.reduce(
    (lastIndex, itemId) => Math.max(lastIndex, order.indexOf(itemId)),
    -1
  );
  return Math.min(Math.max(count, lastSavedResponseIndex + 1), items.length);
}

function normalizeDeck(savedDeck, activity, lessonProgress) {
  const quizOrder =
    Array.isArray(savedDeck?.quizOrder) && savedDeck.quizOrder.length === 0
      ? []
      : normalizeOrder(
          savedDeck?.quizOrder,
          activity.quizzes,
          savedDeck?.selectedQuizId,
          savedDeck?.quizRemaining
        );
  const reflectionOrder =
    Array.isArray(savedDeck?.reflectionOrder) && savedDeck.reflectionOrder.length === 0
      ? []
      : normalizeOrder(
          savedDeck?.reflectionOrder,
          activity.reflections,
          savedDeck?.selectedReflectionId,
          savedDeck?.reflectionRemaining
        );

  return {
    quizOrder,
    quizRevealCount: normalizeRevealCount(
      savedDeck?.quizRevealCount,
      activity.quizzes,
      quizOrder,
      Math.min(2, activity.quizzes.length),
      lessonProgress.quizAnswers,
      "quiz"
    ),
    reflectionOrder,
    reflectionRevealCount: normalizeRevealCount(
      savedDeck?.reflectionRevealCount,
      activity.reflections,
      reflectionOrder,
      Math.min(1, activity.reflections.length),
      lessonProgress.reflections,
      "reflection"
    )
  };
}

function meetsCompletionRequirements(lessonProgress, deck) {
  const answeredQuizCount = deck.quizOrder
    .slice(0, deck.quizRevealCount)
    .filter((quizId) => Number.isInteger(lessonProgress.quizAnswers[quizId])).length;
  const hasReflection = deck.reflectionOrder
    .slice(0, deck.reflectionRevealCount)
    .some((reflectionId) =>
      (lessonProgress.reflections[reflectionId] ?? "").trim().length > 0
    );
  return answeredQuizCount >= 2 && hasReflection;
}

function reconcileProgress(savedProgress, courseModules, activitiesByLessonId) {
  const savedLessonIds = Array.isArray(savedProgress.lessonIds)
    ? savedProgress.lessonIds
    : [];
  const savedLessonsById = new Map(
    savedLessonIds.map((id, index) => [id, savedProgress.lessons[index]])
  );
  const previousCurrentId =
    savedProgress.currentModuleId ?? savedLessonIds[savedProgress.currentModule];
  const nextProgress = createEmptyProgress(courseModules);
  nextProgress.currentModuleId = courseModules.some(
    (module) => module.id === previousCurrentId
  )
    ? previousCurrentId
    : courseModules[0]?.id ?? null;
  nextProgress.currentModule = Math.max(
    courseModules.findIndex((module) => module.id === nextProgress.currentModuleId),
    0
  );

  courseModules.forEach((module, index) => {
    const activity = activitiesByLessonId.get(module.id);
    const savedLesson = savedLessonsById.get(module.id) ?? {
      quizAnswers: {},
      reflections: {},
      completed: false
    };
    const lessonProgress = {
      quizAnswers: normalizeSavedResponses(
        savedLesson.quizAnswers,
        activity?.quizzes ?? [],
        "quiz"
      ),
      reflections: normalizeSavedResponses(
        savedLesson.reflections,
        activity?.reflections ?? [],
        "reflection"
      ),
      completed: savedLesson.completed === true
    };

    nextProgress.lessons[index] = lessonProgress;
    if (activity) {
      const deck = normalizeDeck(
        savedProgress.activityDecks?.[module.id],
        activity,
        lessonProgress
      );
      nextProgress.activityDecks[module.id] = deck;
      if (!meetsCompletionRequirements(lessonProgress, deck)) {
        lessonProgress.completed = false;
      }
    }
  });

  return nextProgress;
}

function migrateLegacyProgress(parsed, courseModules, activitiesByLessonId) {
  const progress = createEmptyProgress(courseModules);
  const maxModuleIndex = Math.max(courseModules.length - 1, 0);
  progress.currentModule = Math.min(Math.max(parsed.currentModule, 0), maxModuleIndex);
  progress.currentModuleId = courseModules[progress.currentModule]?.id ?? null;

  progress.lessons = courseModules.map((module, index) => {
    const savedLesson = parsed.lessons[index];
    const activity = activitiesByLessonId.get(module.id);
    const legacyResponseTarget = activity?.legacyResponseTarget;
    const quiz = activity?.quizzes.find((item) => item.id === legacyResponseTarget?.quiz);
    const reflection = activity?.reflections.find(
      (item) => item.id === legacyResponseTarget?.reflection
    );
    const quizAnswer = savedLesson?.quizAnswer;
    const quizAnswers = {};

    if (
      quiz &&
      Number.isInteger(quizAnswer) &&
      quizAnswer >= 0 &&
      quizAnswer < quiz.options.length
    ) {
      quizAnswers[quiz.id] = quizAnswer;
    }

    const reflections = {};
    if (reflection && typeof savedLesson?.reflection === "string") {
      reflections[reflection.id] = savedLesson.reflection;
    }

    return {
      quizAnswers,
      reflections,
      completed: savedLesson?.completed === true
    };
  });

  courseModules.forEach((module, index) => {
    const activity = activitiesByLessonId.get(module.id);
    if (!activity) {
      return;
    }

    const legacyResponseTarget = activity.legacyResponseTarget;
    const savedDeck = {
      selectedQuizId: legacyResponseTarget?.quiz,
      selectedReflectionId: legacyResponseTarget?.reflection
    };
    progress.activityDecks[module.id] = normalizeDeck(
      savedDeck,
      activity,
      progress.lessons[index]
    );
    if (!meetsCompletionRequirements(progress.lessons[index], progress.activityDecks[module.id])) {
      progress.lessons[index].completed = false;
    }
  });

  progress.migrationNeeded = true;
  return progress;
}

function loadProgress(courseModules, activitiesByLessonId) {
  const emptyProgress = createEmptyProgress(courseModules);

  try {
    const saved = localStorage.getItem(PROGRESS_STORAGE_KEY);
    if (saved === null) {
      const previousModule = localStorage.getItem("currentModule");
      if (previousModule !== null && /^\d+$/.test(previousModule)) {
        emptyProgress.currentModule = Math.min(
          Number(previousModule),
          Math.max(courseModules.length - 1, 0)
        );
      }
      return emptyProgress;
    }

    const parsed = JSON.parse(saved);
    if (
      !Number.isInteger(parsed.currentModule) ||
      !Array.isArray(parsed.lessons)
    ) {
      throw new Error("The saved progress has an unsupported format.");
    }

    if (parsed.version === 1) {
      return migrateLegacyProgress(parsed, courseModules, activitiesByLessonId);
    }

    if (parsed.version !== 2 && parsed.version !== 3 && parsed.version !== PROGRESS_VERSION) {
      throw new Error("The saved progress has an unsupported format.");
    }

    const progress = createEmptyProgress(courseModules);
    const savedLessonIds =
      parsed.version === PROGRESS_VERSION && Array.isArray(parsed.lessonIds)
        ? parsed.lessonIds
        : null;
    const savedCurrentModuleId =
      parsed.version === PROGRESS_VERSION && Number.isInteger(parsed.currentModuleId)
        ? parsed.currentModuleId
        : savedLessonIds?.[parsed.currentModule] ??
          courseModules[
            Math.min(Math.max(parsed.currentModule, 0), Math.max(courseModules.length - 1, 0))
          ]?.id;
    progress.currentModuleId = courseModules.some(
      (module) => module.id === savedCurrentModuleId
    )
      ? savedCurrentModuleId
      : courseModules[0]?.id ?? null;
    progress.currentModule = Math.max(
      courseModules.findIndex((module) => module.id === progress.currentModuleId),
      0
    );
    progress.lessons = courseModules.map((module, index) => {
      const savedLessonIndex = savedLessonIds
        ? savedLessonIds.indexOf(module.id)
        : index;
      const savedLesson =
        savedLessonIndex >= 0 ? parsed.lessons[savedLessonIndex] : null;
      const activity = activitiesByLessonId.get(module.id);

      return {
        quizAnswers: normalizeSavedResponses(
          savedLesson?.quizAnswers,
          activity?.quizzes ?? [],
          "quiz"
        ),
        reflections: normalizeSavedResponses(
          savedLesson?.reflections,
          activity?.reflections ?? [],
          "reflection"
        ),
        completed: savedLesson?.completed === true
      };
    });

    courseModules.forEach((module, index) => {
      const activity = activitiesByLessonId.get(module.id);
      if (!activity) {
        return;
      }

      const normalizedDeck = normalizeDeck(
        parsed.activityDecks?.[module.id],
        activity,
        progress.lessons[index]
      );
      progress.activityDecks[module.id] = normalizedDeck;
      if (!meetsCompletionRequirements(progress.lessons[index], normalizedDeck)) {
        progress.lessons[index].completed = false;
      }
    });

    progress.lessonIds = courseModules.map((module) => module.id);
    if (parsed.version !== PROGRESS_VERSION) {
      progress.migrationNeeded = true;
    }
    return progress;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown storage error.";
    return {
      ...emptyProgress,
      error: `Saved progress could not be loaded: ${message} New activity will start fresh.`
    };
  }
}

async function saveProgress(progress, { keepalive = false, courseId = null } = {}) {
  const savedProgress = { ...progress };
  delete savedProgress.migrationNeeded;
  const payload = JSON.stringify(
    courseId === null ? savedProgress : { courseId, progress: savedProgress }
  );
  const queuedSave = progressSaveQueue.then(async () => {
    try {
      const response = await fetch("/api/progress", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        throw new Error(
          "The server returned a non-JSON response. Start the site with python3 server.py."
        );
      }
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error ?? `Progress save failed (${response.status}).`);
      }
      return { ok: true, progress: result.progress };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown server error.";
      return {
        ok: false,
        message: `Progress could not be saved to SQLite: ${message}`
      };
    }
  });
  progressSaveQueue = queuedSave.then(
    () => undefined,
    () => undefined
  );
  return queuedSave;
}

function clearLegacyProgress() {
  try {
    localStorage.removeItem(PROGRESS_STORAGE_KEY);
    localStorage.removeItem("currentModule");
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown storage error.";
    return {
      ok: false,
      message: `Imported progress is saved in SQLite, but old browser data could not be removed: ${message}`
    };
  }
}
