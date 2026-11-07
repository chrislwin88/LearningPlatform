Learning Platform
=================

Start the local server from this folder:

  python3 -m pip install -r requirements.txt
  python3 server.py

Open http://127.0.0.1:8000/course.html. The server binds to the local computer
only. YouTube embeds require an HTTP origin; opening the page as a file or
serving it with python3 -m http.server will not provide the database API.

Local activity generation
-------------------------

The server uses yt-dlp to retrieve YouTube chapter markers when available and
youtube-transcript-api to retrieve English captions for public YouTube lessons.
It sends lesson material only to a local Ollama model; it does not send video
or caption text to a hosted AI service. Install Ollama, start its local service
and pull the default model. If Ollama is not already running, start
`ollama serve` in a separate terminal, then run:

  ollama pull llama3.2:latest

Install the Python dependencies above before starting the learning platform.
The default model can be changed with OLLAMA_MODEL; the local Ollama API address
can be changed with OLLAMA_BASE_URL, but it must remain on this computer's
loopback interface. For example, set OLLAMA_MODEL before running server.py if
you have chosen another model that is already installed in Ollama.

When the course loads, every YouTube lesson is checked for saved video details.
Missing details are generated and saved before question generation starts;
newly saved video lessons follow the same ordering. Existing details are
reused. Details and questions use separate generation requests and are stored
in different SQLite data, linked only by the YouTube video ID. A failure to
retrieve details is shown in the video-details panel with a retry option and
does not stop question generation. Lessons without a generated question set
are then queued for generation, starting with the selected lesson and
processing one at a time. Lessons with an existing generated question set are
reused.

The “See video details” disclosure displays a concise overview and key topics.
Topics are shown without numbering. Only each topic's timestamp is clickable:
it seeks the embedded YouTube player to that point and remains paused; the topic
title is plain text. Videos do not start automatically when the page loads or
when lessons change. The details disclosure is hidden while Test Your Knowledge
activities are open.

Video explainer
---------------

YouTube lessons include a light-bulb SVG icon over the upper-left of the player.
Hover or focus it to see its purpose; activate it to request a concise
explanation of the current moment. The local server uses timestamped English
captions around the active playback time, representative captions from across
the video, and the saved overview when available. It uses the configured local
Ollama model for one explanation request. Explanation text is temporary and
is not saved to SQLite.

Clicking outside the player, changing lessons, or leaving/reloading the page
cancels the browser request and prevents a late result from changing the
display. An Ollama inference that has already started may continue on the
server until its request timeout. The explainer requires YouTube captions and
a working local Ollama model; direct video files and videos without usable
English captions cannot be explained by this feature.

After an explanation is completed, clicking or hovering outside the player does
not discard it. The answer remains available indefinitely while the video is
paused or has not moved. It is cleared only when playback or a seek moves more
than ten seconds from the timestamp that produced the answer.

Course catalogue
----------------

Open `index.html` to browse the course catalogue. Courses are shown oldest
first in a responsive card grid, with categories for AI courses, News, Legal,
and Business. Selecting a category filters the cards; selecting a card opens
that course in the existing player. New courses can be created with the
plus-button form and begin empty so lessons can be added from the player.
Course cards show the lesson count. Expected duration is shown when cached
video durations are available and is estimated as video time plus 50%; empty
courses omit duration, while non-empty courses without usable durations show
that duration is unavailable.
Opening an empty course automatically opens its lesson editor. The edit pencil
is hidden, the add-lesson form is shown, and the save check becomes available
only after a valid video lesson has been added. The first lesson is not loaded
until the changes are saved.
For lessons added after this pipeline update, existing YouTube chapter markers
are preferred. When they are unavailable, the server cleans the cached caption
text while retaining each sentence's original caption segment and start time.
A local model scans the sentences in order, identifies semantic topic changes,
and supplies a title and starting sentence ID for each chapter. The server
maps those IDs back to the original caption times, then checks that chapter
starts are valid, distinct, chronological, and within the video duration. If
generated boundaries fail validation, the model is prompted once to correct
them; a second failure is reported with a retry option rather than silently
publishing invalid timestamps.

This revised caption-semantic process is used for newly added lessons only.
Previously saved video details and existing lessons' detail behavior are not
rewritten by this change. Full captions are cached by YouTube video ID and
reused for both details and questions. Direct video files do not currently
have an automatic details source, but remain playable as usual.
Each set contains five multiple-choice questions and two reflection prompts.
Generated activities are saved as an immutable SQLite snapshot for that
attempt and reused after reloads. Re-attempt requests a new set and clears
that lesson's saved responses. The interface still reveals two quiz questions
and one reflection prompt initially.
For generated quizzes, Ollama must identify the exact correct option text.
The server matches that text to the option list and derives the zero-based
answer index itself, rather than relying on a model-generated numeric index.
Generated learner-facing questions and prompts must not refer to their source;
feedback explains the reasoning without repeating the correct option.
Already-saved generated attempts remain unchanged; this validation applies to
new generations and explicit Re-attempts.
Local inference may take a minute or more depending on the machine. The Test
Your Knowledge button remains available while generation is queued or running;
the question panel shows the processing status. Generic starter questions are
never displayed. During a Re-attempt, the previous questions are hidden while
the replacement is generated; if generation fails, a previous non-generic
set is restored and the panel offers a retry. If initial generation
fails, the panel remains without questions and offers a retry. After
processing finishes, the activity panel shows the time spent generating that
lesson's questions; time waiting for earlier queue items is not included.
Automatic generation does not replace activities for lessons with saved
responses or completion. Re-attempt remains the explicit way to replace those
activities and reset that lesson's responses.

Caption retrieval requires an internet connection and can fail if a video has
no English captions or YouTube blocks the request. In that case, no generic
fallback activities are shown; the panel reports the failure and provides a
retry action. On the first generation for a YouTube video, all usable English
caption segments, including their text and timing, are saved in SQLite in the
`transcript_cache` table before Ollama is called. The cache is keyed by YouTube
video ID, so a Re-attempt or another lesson using the same video reuses it
without fetching captions again. Cache entries remain in the database even
after lessons using that video are removed. To clear all cached transcripts,
stop the server and run:

  sqlite3 data/learning-platform.sqlite3 "DELETE FROM transcript_cache;"

Long transcripts are reduced to bounded caption excerpts sampled across the
video timeline before they are sent to Ollama. Transcript text is sent only to
the local Ollama service; it is not sent to a hosted AI service. Learner
answers and reflections are not sent to Ollama. Keep Ollama bound to loopback;
do not expose its unauthenticated API to a network.

Generated questions can still contain mistakes even when their output passes
format validation. Review them as learning aids, not as authoritative grading.

SQLite source of truth
----------------------

The first server start creates data/learning-platform.sqlite3 and seeds it
from data/archive/modules.js and data/archive/activities.js.
data/course-edits.json is not read or written by the server and has no effect
on the running course. If the archived JavaScript seed files cannot be read,
the server reports an error instead of starting with an empty course.

After import, SQLite is the runtime source of truth for lessons, quizzes,
answer choices, reflections, learner responses, completion, current lesson,
shuffled activity state, generated activity attempts, cached YouTube captions,
and video details. Existing databases are migrated automatically when the
server starts. The archived JavaScript files are used only to
seed a new database; editing or deleting them after the database is created
does not change the running course. Course edits are saved through the local
server to SQLite.

The main table relationships are:

  courses
    └── lessons
          ├── quizzes ── quiz_options
          ├── reflections
          ├── activity_attempts ── lesson_activity_state
          │     ├── attempt_quizzes ── attempt_quiz_options
          │     └── attempt_reflections
          ├── learner_lesson_state
          └── lesson_activity_generation

  video_details                         (keyed by YouTube video ID)

  learners
    ├── learner_state                 (current lesson)
    ├── learner_media_progress         (last position in each lesson video)
    ├── learner_lesson_state           (completion and reveal counts)
    ├── learner_activity_order         (shuffled prompt order)
    ├── learner_quiz_responses
    ├── learner_reflection_responses
    ├── learner_attempt_quiz_responses
    └── learner_attempt_reflection_responses

  transcript_cache                     (keyed by YouTube video ID)

Generated attempts store metadata such as their model, generation duration,
and whether captions were excerpted. Their related `attempt_*` tables store
generated questions, options, correct answers, feedback, and reflection
prompts. The `transcript_cache` table stores full English caption segments and
timestamps for reuse; it does not store Ollama prompts or generated content.
The separate `video_details` table stores only each video's overview and key
topics, keyed by video ID. It is not part of an activity attempt and is
unaffected by question Re-attempts or learner-response resets. Cached captions
and video details do not reference lessons, so they can be reused after a
lesson is deleted and are cleared only by explicitly clearing the respective
cache or deleting the database. Learner responses and progress are stored
separately in learner-related tables.
Video playback positions are saved to SQLite and restored when the same lesson
and media are opened again. The app saves periodically and when playback is
paused, a lesson changes, or the page is hidden or closed. A browser-side
recovery copy is used if SQLite is temporarily unreachable; successful saves
sync it back to SQLite. Replacing a lesson's video does not reuse the previous
media's position.

The local app currently uses one learner profile and does not have accounts,
course sharing, or cross-device identity. Back up the course and learner data
by stopping the server and copying data/learning-platform.sqlite3.
Lesson descriptions are no longer part of the catalog response or displayed
under lesson titles. Existing values remain in the legacy SQLite column for
compatibility and are preserved when catalog changes are saved.

Existing browser progress
-------------------------

The first time a browser opens the SQLite-backed app, its existing saved
progress (versions 1 through 4) is imported once into the database. It
includes quiz selections, reflection text, lesson completion, current lesson,
shuffled activity order, and reveal counts. The browser's old progress entry
is removed only after the server confirms the database import. Theme
preference remains in browser storage.

Lesson editor
-------------

Select the pen at the top-right of the course panel to edit the sidebar.
The lessons panel starts expanded. Use the three-bar menu button to the left of
the course title to minimize or restore it on any screen size. When minimized,
only the three-bar control remains visible; the lesson list, progress, course
title, and editor are hidden. The sidebar card animates into a compact 50px
square with even spacing around the bars. The video player expands into the
freed horizontal space, and its height grows proportionally with its width.
Below 900px, the sidebar starts collapsed automatically so the player gets
the available width. It can still be expanded manually; leaving the narrow
range restores the normal expanded layout.
Click the course name or a lesson title to edit it inline; for lesson titles,
drag the card to reorder it instead. Keyboard users can focus a lesson title
and press Enter or Space to edit it. While a title input is open, its card
cannot be dragged so the text can be selected. Use the check mark to save title
changes along with other course edits. The course completion count remains
visible, while individual lesson status labels are hidden during editing. Use
the circled X to remove a lesson; confirming also
deletes that lesson's saved answers, reflections, completion state, and
activity order. Use the circled plus at the bottom to enter a lesson title
and video URL. The URL must be a YouTube video link or a direct MP4, WebM, or
Ogg video link.

New lessons initially have no questions or reflection prompts. Select the
check mark to save changes to SQLite; after the save succeeds, that lesson is
queued for video-based questions. The interactive panel shows a processing
status and no generic starter activities while generation runs. If saving
progress occurs before an activity attempt is created, the lesson's learner
progress is stored without an attempt and is attached automatically when
question generation finishes.
fails, the editor remains open and displays the error.

The editor uses Lucide-style inline SVG icons for its edit, save, and remove
controls. When a video URL is entered, YouTube titles are suggested using
YouTube metadata. Direct video links use a readable title derived from the
filename. Suggested titles remain editable; a failed YouTube lookup does not
prevent entering a title manually or adding the video. YouTube title lookup
requires an internet connection.
Icon source: Lucide (ISC License), https://lucide.dev/icons/pencil,
https://lucide.dev/icons/check, and https://lucide.dev/icons/x.

Learning activities
-------------------

The video is shown first for each lesson, followed by its title. Select Test
Your Knowledge below the title to switch to the lesson quiz and reflection
prompts; use Back to Video to return to the player. Video details are hidden
while activities are open. Within the current page session, switching lessons
restores whether that lesson was last showing its video or question panel.
This view preference is held only in browser memory and resets to video after
a page reload. Each attempt shuffles the lesson's question and reflection lists.
Two quiz questions and one reflection prompt appear initially. Use the
down-chevron buttons to reveal the next two quiz questions or next reflection;
previously revealed prompts stay visible. The shuffled order and reveal
progress remain the same when switching lessons or refreshing the page.

Quiz answers and reflection text save automatically to SQLite. To complete a
lesson, answer at least two displayed quiz questions and write a non-empty
response to at least one displayed reflection. Correctness is not required
to count a quiz question as answered.

Re-attempt asks for confirmation because it changes the questions/reflections
and deletes all saved activity responses for that lesson. Confirming also
resets its completion state and starts a newly shuffled attempt. Cancelling
leaves the current attempt unchanged. Other lessons' saved responses are
unaffected.

After marking a lesson complete, use Next Video in the activity controls to
continue to the next lesson. The video navigation arrows remain available.

Display
-------

The header toggle switches between light and dark mode. The page follows the
device appearance setting until a theme is selected, then remembers that
choice in the current browser. A simple footer displays the LearnHub LMS
copyright notice.

The platform generates activities locally with Ollama from YouTube captions.
It does not grade free-text reflections.
