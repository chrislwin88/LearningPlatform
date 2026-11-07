import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import ANY, Mock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import server


ROOT = Path(__file__).resolve().parents[1]


def generated_payload():
    return {
        "quizzes": [
            {
                "question": f"Question {index + 1}?",
                "options": [
                    f"Choice {index + 1}A",
                    f"Choice {index + 1}B",
                    f"Choice {index + 1}C",
                    f"Choice {index + 1}D",
                ],
                "correct_option": f"Choice {index + 1}{'ABCD'[index % 4]}",
                "feedback": "The lesson explanation supports this choice.",
            }
            for index in range(5)
        ],
        "reflections": [
            {"prompt": "What idea stood out to you?"},
            {"prompt": "How could you apply one idea?"},
        ],
    }


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temporary_directory.name) / "learning.sqlite3"

    def tearDown(self):
        self.temporary_directory.cleanup()

    def test_seeds_course_and_persists_learner_responses(self):
        connection = server.initialize_database(self.database_path)
        try:
            catalog = server.catalog_from_database(connection)
            progress = server.empty_progress(catalog)
            for lesson in catalog["lessons"]:
                deck = progress["activityDecks"][lesson["id"]]
                deck["quizOrder"] = [
                    quiz["id"] for quiz in lesson["activities"]["quizzes"]
                ]
                deck["reflectionOrder"] = [
                    reflection["id"] for reflection in lesson["activities"]["reflections"]
                ]

            first_lesson = catalog["lessons"][0]
            first_deck = progress["activityDecks"][first_lesson["id"]]
            first_state = progress["lessons"][0]
            first_state["quizAnswers"] = {
                quiz_id: 0 for quiz_id in first_deck["quizOrder"][:2]
            }
            first_state["reflections"] = {
                first_deck["reflectionOrder"][0]: "A saved response."
            }
            first_state["completed"] = True

            saved, imported = server.save_progress(
                connection, progress, only_if_missing=True
            )
            self.assertTrue(imported)
            self.assertTrue(saved["lessons"][0]["completed"])
            self.assertEqual(
                saved["lessons"][0]["reflections"][first_deck["reflectionOrder"][0]],
                "A saved response.",
            )

            unchanged, imported = server.save_progress(
                connection, progress, only_if_missing=True
            )
            self.assertFalse(imported)
            self.assertEqual(unchanged, saved)

            reordered_catalog = {
                **catalog,
                "lessons": list(reversed(catalog["lessons"])),
            }
            with connection:
                server.save_catalog(connection, reordered_catalog)
            reordered_progress = server.progress_from_database(connection)
            first_index = reordered_progress["lessonIds"].index(first_lesson["id"])
            self.assertTrue(reordered_progress["lessons"][first_index]["completed"])

            removed_catalog = {
                **reordered_catalog,
                "lessons": [
                    lesson
                    for lesson in reordered_catalog["lessons"]
                    if lesson["id"] != first_lesson["id"]
                ],
            }
            with connection:
                server.save_catalog(connection, removed_catalog)
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
            self.assertIsNone(
                connection.execute(
                    "SELECT 1 FROM learner_quiz_responses WHERE lesson_id = ?",
                    (first_lesson["id"],),
                ).fetchone()
            )
        finally:
            connection.close()

    def test_saves_pending_lesson_progress_without_active_attempt(self):
        connection = server.initialize_database(self.database_path)
        try:
            catalog = {
                "title": "Pending activity course",
                "lessons": [
                    {
                        "id": 9001,
                        "title": "New lesson",
                        "type": "youtube",
                        "videoId": "aircAruvnKk",
                        "activities": {"quizzes": [], "reflections": []},
                    }
                ],
            }
            with connection:
                server.save_catalog(connection, catalog, course_id=3)
                connection.execute(
                    "DELETE FROM lesson_activity_state WHERE lesson_id = ?", (9001,)
                )

            progress = server.empty_progress(
                server.catalog_from_database(connection, course_id=3)
            )
            saved, imported = server.save_progress(
                connection, progress, course_id=3
            )

            self.assertTrue(imported)
            self.assertEqual(saved["lessonIds"], [9001])
            state = connection.execute(
                """
                SELECT active_attempt_id FROM learner_lesson_state
                WHERE learner_id = 1 AND lesson_id = 9001
                """
            ).fetchone()
            self.assertIsNotNone(state)
            self.assertIsNone(state["active_attempt_id"])
        finally:
            connection.close()

    def test_video_details_generation_preserves_saved_learner_responses(self):
        connection = server.initialize_database(self.database_path)
        try:
            catalog = server.catalog_from_database(connection)
            progress = server.empty_progress(catalog)
            for lesson in catalog["lessons"]:
                deck = progress["activityDecks"][lesson["id"]]
                deck["quizOrder"] = [
                    quiz["id"] for quiz in lesson["activities"]["quizzes"]
                ]
                deck["reflectionOrder"] = [
                    item["id"] for item in lesson["activities"]["reflections"]
                ]
            lesson = catalog["lessons"][0]
            lesson_progress = progress["lessons"][0]
            lesson_progress["quizAnswers"] = {
                progress["activityDecks"][lesson["id"]]["quizOrder"][0]: 2
            }
            lesson_progress["reflections"] = {
                progress["activityDecks"][lesson["id"]]["reflectionOrder"][0]:
                    "My saved reflection."
            }
            lesson_progress["completed"] = True
            server.save_progress(connection, progress)
            progress_before = server.progress_from_database(connection)

            segments = [
                SimpleNamespace(text="Opening point.", start=0, duration=3),
                SimpleNamespace(text="Closing point.", start=25, duration=3),
            ]
            with connection:
                connection.execute(
                    "INSERT INTO transcript_cache (video_id, segments_json) VALUES (?, ?)",
                    (
                        lesson["videoId"],
                        server.transcript_segments_to_json(segments),
                    ),
                )
            with (
                patch.object(server, "fetch_youtube_chapters", return_value=[]),
                patch.object(
                    server,
                    "generate_video_details_with_ollama",
                    return_value={
                        "summary": "A concise overview.",
                        "topics": [{"title": "Opening", "timestampSeconds": 0}],
                    },
                ),
            ):
                server.ensure_video_details(connection, lesson["videoId"])

            self.assertEqual(server.progress_from_database(connection), progress_before)
        finally:
            connection.close()

    def test_json_course_edits_file_does_not_affect_database_seed(self):
        ignored_json = Path(self.temporary_directory.name) / "course-edits.json"
        ignored_json.write_text(
            json.dumps({"title": "Must not be used", "lessons": []}),
            encoding="utf-8",
        )
        connection = server.initialize_database(
            self.database_path,
            ROOT / "data" / "archive" / "modules.js",
            ROOT / "data" / "archive" / "activities.js",
        )
        try:
            catalog = server.catalog_from_database(connection)
            self.assertEqual(len(catalog["lessons"]), 5)
            self.assertEqual(catalog["lessons"][3]["videoId"], "EWvNQjAaOHw")
            self.assertNotEqual(catalog["title"], "Must not be used")
        finally:
            connection.close()

    def test_new_lesson_can_be_saved_with_no_starter_activities(self):
        connection = server.initialize_database(self.database_path)
        try:
            catalog = server.catalog_from_database(connection)
            lesson_id = max(lesson["id"] for lesson in catalog["lessons"]) + 1
            catalog["lessons"].append(
                {
                    "id": lesson_id,
                    "title": "New video",
                    "type": "youtube",
                    "videoId": "kyQ0CRkYhy4",
                    "activities": {"quizzes": [], "reflections": []},
                }
            )
            with connection:
                server.save_catalog(connection, catalog)

            saved_catalog = server.catalog_from_database(connection)
            new_lesson = saved_catalog["lessons"][-1]
            self.assertNotIn("description", new_lesson)
            self.assertEqual(
                new_lesson["activities"], {"quizzes": [], "reflections": []}
            )
            attempt_id = connection.execute(
                """
                SELECT active_attempt_id FROM lesson_activity_state
                WHERE lesson_id = ?
                """,
                (lesson_id,),
            ).fetchone()[0]
            self.assertEqual(
                server.activities_for_attempt(connection, attempt_id),
                {"quizzes": [], "reflections": []},
            )
            progress = server.empty_progress(saved_catalog)
            saved_progress, _ = server.save_progress(connection, progress)
            self.assertEqual(
                saved_progress["activityDecks"][lesson_id]["quizOrder"], []
            )
        finally:
            connection.close()

    def test_catalog_omits_legacy_descriptions_and_preserves_them_on_save(self):
        connection = server.initialize_database(self.database_path)
        try:
            lesson_id = 1
            stored_description = connection.execute(
                "SELECT description FROM lessons WHERE id = ?", (lesson_id,)
            ).fetchone()[0]
            catalog = server.catalog_from_database(connection)
            self.assertTrue(
                all("description" not in lesson for lesson in catalog["lessons"])
            )

            with connection:
                server.save_catalog(connection, catalog)

            self.assertEqual(
                connection.execute(
                    "SELECT description FROM lessons WHERE id = ?", (lesson_id,)
                ).fetchone()[0],
                stored_description,
            )
        finally:
            connection.close()

    def test_playback_position_is_saved_per_lesson_and_media(self):
        connection = server.initialize_database(self.database_path)
        try:
            first = server.save_playback_position(connection, 1, 38.625)
            self.assertEqual(first["positionSeconds"], 38.625)
            self.assertEqual(
                server.load_playback_position(connection, 1)["positionSeconds"],
                38.625,
            )
            for invalid_position in (-1, float("nan"), float("inf"), True, "12"):
                with self.subTest(position=invalid_position):
                    with self.assertRaises(ValueError):
                        server.save_playback_position(
                            connection, 1, invalid_position
                        )

            with connection:
                connection.execute(
                    "UPDATE lessons SET video_id = ? WHERE id = ?",
                    ("aaaaaaaaaaa", 1),
                )
            self.assertIsNone(server.load_playback_position(connection, 1))
        finally:
            connection.close()

    def test_youtube_metadata_request_uses_fixed_youtube_host(self):
        response = Mock()
        response.read.return_value = b'{"title": "Metadata title"}'
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        with patch.object(server, "urlopen", return_value=response) as open_url:
            title = server.fetch_youtube_video_title("kyQ0CRkYhy4")
        self.assertEqual(title, "Metadata title")
        self.assertIn("https://www.youtube.com/oembed?", open_url.call_args.args[0].full_url)

        with self.assertRaises(ValueError):
            server.fetch_youtube_video_title("https://untrusted.example/video")

    def test_transcript_fetch_uses_english_and_samples_oversized_text(self):
        segments = [SimpleNamespace(text="  English caption  ")]
        with patch(
            "youtube_transcript_api.YouTubeTranscriptApi"
        ) as transcript_api:
            transcript_api.return_value.fetch.return_value = segments
            self.assertEqual(
                server.fetch_youtube_transcript("kyQ0CRkYhy4"), "English caption"
            )
            transcript_api.assert_called_once()
            transcript_api.return_value.fetch.assert_called_once_with(
                "kyQ0CRkYhy4", languages=["en"]
            )

        with patch(
            "youtube_transcript_api.YouTubeTranscriptApi"
        ) as transcript_api:
            transcript_api.return_value.fetch.return_value = [
                SimpleNamespace(
                    text="x " * (server.MAX_TRANSCRIPT_CHARACTERS + 1),
                    start=0,
                    duration=10,
                )
            ]
            excerpt, was_sampled = server.fetch_youtube_transcript_with_metadata(
                "kyQ0CRkYhy4"
            )
            self.assertTrue(was_sampled)
            self.assertLessEqual(len(excerpt), server.MAX_TRANSCRIPT_CHARACTERS)
            self.assertIn("[Caption excerpt at 00:00:00]", excerpt)

        segments = [
            SimpleNamespace(
                text=f"part-{index} " + "detail " * 100,
                start=index * 10,
                duration=10,
            )
            for index in range(90)
        ]
        with patch(
            "youtube_transcript_api.YouTubeTranscriptApi"
        ) as transcript_api:
            transcript_api.return_value.fetch.return_value = segments
            excerpt, was_sampled = server.fetch_youtube_transcript_with_metadata(
                "kyQ0CRkYhy4"
            )
        self.assertTrue(was_sampled)
        self.assertIn("part-0", excerpt)
        self.assertIn("part-80", excerpt)
        self.assertEqual(excerpt.count("[Caption excerpt at "), 9)

    def test_youtube_chapter_fetch_uses_yt_dlp_without_downloading_video(self):
        class FakeYoutubeDL:
            def __init__(self, options):
                self.options = options

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def extract_info(self, url, download):
                self.url = url
                self.download = download
                return {
                    "chapters": [
                        {"title": "Later", "start_time": 30.7},
                        {"title": "Earlier", "start_time": 4.2},
                    ]
                }

        fake_ytdlp = SimpleNamespace(
            YoutubeDL=FakeYoutubeDL,
            utils=SimpleNamespace(DownloadError=RuntimeError),
        )
        with patch.dict("sys.modules", {"yt_dlp": fake_ytdlp}):
            chapters = server.fetch_youtube_chapters("kyQ0CRkYhy4")

        self.assertEqual(
            chapters,
            [
                {"title": "Earlier", "timestampSeconds": 4},
                {"title": "Later", "timestampSeconds": 30},
            ],
        )

    def test_transcript_cache_persists_full_segments_and_reuses_them(self):
        connection = server.initialize_database(self.database_path)
        segments = [
            SimpleNamespace(text="First caption.", start=0, duration=2),
            SimpleNamespace(text="Second caption.", start=2, duration=3),
        ]
        generated = server.normalize_generated_activities(generated_payload())
        try:
            with (
                patch.object(
                    server,
                    "fetch_youtube_transcript_segments",
                    return_value=segments,
                ) as fetch,
                patch.object(
                    server,
                    "generate_activities_with_ollama",
                    return_value=generated,
                ) as generate,
            ):
                first, first_excerpted = server.generate_activities_from_transcript(
                    "kyQ0CRkYhy4", connection=connection
                )
                second, second_excerpted = server.generate_activities_from_transcript(
                    "kyQ0CRkYhy4", connection=connection
                )

            self.assertEqual(first["quizzes"], second["quizzes"])
            self.assertFalse(first_excerpted)
            self.assertFalse(second_excerpted)
            fetch.assert_called_once_with("kyQ0CRkYhy4")
            self.assertEqual(generate.call_count, 2)
            cached = connection.execute(
                "SELECT segments_json FROM transcript_cache WHERE video_id = ?",
                ("kyQ0CRkYhy4",),
            ).fetchone()
            self.assertEqual(
                json.loads(cached["segments_json"]),
                [
                    {"text": "First caption.", "start": 0.0, "duration": 2.0},
                    {"text": "Second caption.", "start": 2.0, "duration": 3.0},
                ],
            )
        finally:
            connection.close()

    def test_video_details_use_source_chapters_and_persist_separately(self):
        connection = server.initialize_database(self.database_path)
        video_id = "kyQ0CRkYhy4"
        activity_attempt_count = connection.execute(
            "SELECT COUNT(*) FROM activity_attempts"
        ).fetchone()[0]
        with connection:
            connection.execute(
                """
                INSERT INTO transcript_cache (video_id, segments_json)
                VALUES (?, ?)
                """,
                (
                    video_id,
                    server.transcript_segments_to_json(
                        [
                            SimpleNamespace(
                                text="A cached overview source.", start=0, duration=90
                            )
                        ]
                    ),
                ),
            )
        chapters = [
            {"title": "Introduction", "timestampSeconds": 0},
            {"title": "Main concept", "timestampSeconds": 75},
        ]
        try:
            with (
                patch.object(server, "fetch_youtube_chapters", return_value=chapters) as fetch_chapters,
                patch.object(
                    server,
                    "generate_video_details_with_ollama",
                    return_value={"summary": "A concise overview.", "topics": []},
                ) as generate_details,
            ):
                details = server.ensure_video_details(connection, video_id)
                cached_details = server.ensure_video_details(connection, video_id)

            self.assertEqual(details, {
                "summary": "A concise overview.",
                "topics": chapters,
            })
            self.assertEqual(cached_details, details)
            fetch_chapters.assert_called_once_with(video_id)
            generate_details.assert_called_once()
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM activity_attempts"
                ).fetchone()[0],
                activity_attempt_count,
            )
            stored = connection.execute(
                "SELECT details_json FROM video_details WHERE video_id = ?",
                (video_id,),
            ).fetchone()
            self.assertEqual(json.loads(stored["details_json"]), details)
            self.assertEqual(
                connection.execute(
                    "PRAGMA foreign_key_list(video_details)"
                ).fetchall(),
                [],
            )
        finally:
            connection.close()

    def test_video_details_fall_back_to_cached_caption_timestamps(self):
        connection = server.initialize_database(self.database_path)
        video_id = "kyQ0CRkYhy4"
        segments = [
            SimpleNamespace(text="Opening idea.", start=0, duration=3),
            SimpleNamespace(text="Second idea.", start=35, duration=4),
            SimpleNamespace(text="Final idea.", start=82, duration=5),
        ]
        with connection:
            connection.execute(
                "INSERT INTO transcript_cache (video_id, segments_json) VALUES (?, ?)",
                (video_id, server.transcript_segments_to_json(segments)),
            )
        try:
            with (
                patch.object(server, "fetch_youtube_chapters", return_value=[]),
                patch.object(
                    server,
                    "generate_video_details_with_ollama",
                    return_value={
                        "summary": "A concise overview.",
                        "topics": [
                            {"title": "Opening", "timestampSeconds": 0},
                            {"title": "Second idea", "timestampSeconds": 35},
                        ],
                    },
                ) as generate_details,
            ):
                details = server.ensure_video_details(connection, video_id)

            self.assertEqual(
                details["topics"],
                [
                    {"title": "Opening", "timestampSeconds": 0},
                    {"title": "Second idea", "timestampSeconds": 35},
                ],
            )
            allowed_segments = generate_details.call_args.args[1]
            self.assertEqual(
                [item["timestamp"] for item in allowed_segments],
                ["00:00:00", "00:00:35", "00:01:22"],
            )
        finally:
            connection.close()

    def test_empty_saved_video_details_are_regenerated(self):
        connection = server.initialize_database(self.database_path)
        video_id = "kyQ0CRkYhy4"
        segments = [
            SimpleNamespace(text="Opening idea.", start=0, duration=3),
            SimpleNamespace(text="Second idea.", start=35, duration=4),
        ]
        with connection:
            connection.execute(
                "INSERT INTO transcript_cache (video_id, segments_json) VALUES (?, ?)",
                (video_id, server.transcript_segments_to_json(segments)),
            )
            connection.execute(
                "INSERT INTO video_details (video_id, details_json) VALUES (?, ?)",
                (
                    video_id,
                    json.dumps({"summary": "Old summary.", "topics": []}),
                ),
            )
        try:
            with (
                patch.object(server, "fetch_youtube_chapters", return_value=[]),
                patch.object(
                    server,
                    "generate_video_details_with_ollama",
                    return_value={
                        "summary": "A refreshed overview.",
                        "topics": [{"title": "Opening", "timestampSeconds": 0}],
                    },
                ) as generate_details,
            ):
                details = server.ensure_video_details(connection, video_id)

            self.assertEqual(details["summary"], "A refreshed overview.")
            self.assertTrue(details["topics"])
            generate_details.assert_called_once()
        finally:
            connection.close()

    def test_video_details_loader_preserves_fractional_caption_timestamps(self):
        connection = server.initialize_database(self.database_path)
        video_id = "kyQ0CRkYhy4"
        details = {
            "summary": "A concise overview.",
            "topics": [{"title": "Opening", "timestampSeconds": 12.75}],
        }
        try:
            with connection:
                connection.execute(
                    "INSERT INTO video_details (video_id, details_json) VALUES (?, ?)",
                    (video_id, json.dumps(details)),
                )

            self.assertEqual(server.load_video_details(connection, video_id), details)
            self.assertIsNotNone(
                connection.execute(
                    "SELECT 1 FROM video_details WHERE video_id = ?", (video_id,)
                ).fetchone()
            )
        finally:
            connection.close()

    def test_video_details_reject_timestamps_not_in_cached_captions(self):
        allowed = [
            {
                "timestamp": "00:00:12",
                "timestampSeconds": 12,
                "text": "A caption excerpt.",
            }
        ]
        with self.assertRaisesRegex(ValueError, "unavailable timestamp"):
            server.normalize_video_details(
                {
                    "summary": "An overview.",
                    "topics": [{"title": "Topic", "timestamp": "00:00:13"}],
                },
                allowed,
            )

    def test_video_details_remain_after_lesson_activity_reattempt(self):
        connection = server.initialize_database(self.database_path)
        try:
            lesson = server.catalog_from_database(connection)["lessons"][0]
            stored_details = {
                "summary": "A saved overview.",
                "topics": [{"title": "Topic", "timestampSeconds": 10}],
            }
            with connection:
                connection.execute(
                    "INSERT INTO video_details (video_id, details_json) VALUES (?, ?)",
                    (
                        lesson["videoId"],
                        json.dumps(stored_details),
                    ),
                )
            generated = server.normalize_generated_activities(generated_payload())
            with patch.object(
                server,
                "generate_activities_from_transcript",
                return_value=(generated, False),
            ):
                server.start_activity_attempt(connection, lesson["id"], "reattempt")

            self.assertEqual(
                server.load_video_details(connection, lesson["videoId"]),
                stored_details,
            )
        finally:
            connection.close()

    def test_existing_saved_details_are_not_regenerated_for_new_lesson_path(self):
        connection = server.initialize_database(self.database_path)
        video_id = "kyQ0CRkYhy4"
        details = {
            "summary": "Existing saved overview.",
            "topics": [{"title": "Existing topic", "timestampSeconds": 15}],
        }
        with connection:
            connection.execute(
                "INSERT INTO video_details (video_id, details_json) VALUES (?, ?)",
                (video_id, json.dumps(details)),
            )
        try:
            with patch.object(server, "fetch_youtube_chapters") as fetch:
                cached = server.ensure_video_details(
                    connection, video_id, new_lesson=True
                )
            self.assertEqual(cached, details)
            fetch.assert_not_called()
        finally:
            connection.close()

    def test_transcript_is_cached_before_ollama_failure_and_reused_on_retry(self):
        connection = server.initialize_database(self.database_path)
        segments = [SimpleNamespace(text="Cached caption.", start=0, duration=2)]
        generated = server.normalize_generated_activities(generated_payload())
        try:
            with (
                patch.object(
                    server,
                    "fetch_youtube_transcript_segments",
                    return_value=segments,
                ) as fetch,
                patch.object(
                    server,
                    "generate_activities_with_ollama",
                    side_effect=[
                        RuntimeError("Ollama is unavailable"),
                        generated,
                    ],
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "Ollama is unavailable"):
                    server.generate_activities_from_transcript(
                        "kyQ0CRkYhy4", connection=connection
                    )

                activities, _ = server.generate_activities_from_transcript(
                    "kyQ0CRkYhy4", connection=connection
                )

            self.assertEqual(len(activities["quizzes"]), 5)
            fetch.assert_called_once_with("kyQ0CRkYhy4")
        finally:
            connection.close()

    def test_activity_reattempt_reuses_cached_captions(self):
        connection = server.initialize_database(self.database_path)
        lesson = server.catalog_from_database(connection)["lessons"][0]
        segments = [
            SimpleNamespace(text="Lesson caption.", start=0, duration=4)
        ]
        generated = server.normalize_generated_activities(generated_payload())
        try:
            with (
                patch.object(
                    server,
                    "fetch_youtube_transcript_segments",
                    return_value=segments,
                ) as fetch,
                patch.object(
                    server,
                    "generate_activities_with_ollama",
                    return_value=generated,
                ),
            ):
                first = server.start_activity_attempt(
                    connection, lesson["id"], "start"
                )
                second = server.start_activity_attempt(
                    connection, lesson["id"], "reattempt"
                )

            self.assertNotEqual(
                first["attempt"]["attemptId"], second["attempt"]["attemptId"]
            )
            self.assertEqual(fetch.call_count, 1)
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM transcript_cache WHERE video_id = ?",
                    (lesson["videoId"],),
                ).fetchone()[0],
                1,
            )
        finally:
            connection.close()

    def test_transcript_cache_isolated_by_video_id_and_survives_lesson_removal(self):
        connection = server.initialize_database(self.database_path)
        segments = [SimpleNamespace(text="A caption.", start=0, duration=1)]
        try:
            with patch.object(
                server,
                "fetch_youtube_transcript_segments",
                return_value=segments,
            ) as fetch:
                server.cached_or_fetch_youtube_transcript(connection, "kyQ0CRkYhy4")
                server.cached_or_fetch_youtube_transcript(connection, "aaaaaaaaaaa")
            self.assertEqual(fetch.call_count, 2)
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM transcript_cache").fetchone()[0],
                2,
            )

            catalog = server.catalog_from_database(connection)
            removed_lesson = catalog["lessons"][0]
            server.cached_or_fetch_youtube_transcript(
                connection, removed_lesson["videoId"]
            )
            catalog["lessons"] = [
                lesson for lesson in catalog["lessons"]
                if lesson["id"] != removed_lesson["id"]
            ]
            with connection:
                server.save_catalog(connection, catalog)
            self.assertIsNotNone(
                connection.execute(
                    "SELECT 1 FROM transcript_cache WHERE video_id = ?",
                    (removed_lesson["videoId"],),
                ).fetchone()
            )
        finally:
            connection.close()

    def test_ollama_output_is_normalized_and_rejects_invalid_answers(self):
        normalized = server.normalize_generated_activities(generated_payload())
        self.assertEqual(len(normalized["quizzes"]), 5)
        self.assertEqual(len(normalized["reflections"]), 2)
        self.assertEqual(len({quiz["id"] for quiz in normalized["quizzes"]}), 5)

        invalid = generated_payload()
        invalid["quizzes"][0]["correct_option"] = "Not one of the options"
        with self.assertRaisesRegex(ValueError, "exactly match one"):
            server.normalize_generated_activities(invalid)

        generic = generated_payload()
        generic["quizzes"][0]["question"] = (
            "What is a useful way to learn from a video lesson?"
        )
        with self.assertRaisesRegex(ValueError, "generic starter question"):
            server.normalize_generated_activities(generic)

        invalid_question = generated_payload()
        invalid_question["quizzes"][0]["question"] = (
            "{answer: 'to perform calculations'}"
        )
        with self.assertRaisesRegex(ValueError, "answer-shaped"):
            server.normalize_generated_activities(invalid_question)

        invalid_option = generated_payload()
        invalid_option["quizzes"][0]["options"][0] = (
            "{answer: 'to perform calculations'}"
        )
        with self.assertRaisesRegex(ValueError, "answer-shaped option"):
            server.normalize_generated_activities(invalid_option)

    def test_generated_learner_text_avoids_source_references(self):
        source_reference = generated_payload()
        source_reference["quizzes"][0]["question"] = (
            "According to the transcript, what happens next?"
        )
        with self.assertRaisesRegex(ValueError, "must not refer to the lesson source"):
            server.normalize_generated_activities(source_reference)

        repeated_answer = generated_payload()
        repeated_answer["quizzes"][0]["feedback"] = (
            "Choice 1A is correct because it matches the lesson."
        )
        normalized = server.normalize_generated_activities(repeated_answer)
        self.assertEqual(
            normalized["quizzes"][0]["feedback"],
            repeated_answer["quizzes"][0]["feedback"],
        )

    def test_correct_option_text_maps_to_each_zero_based_position(self):
        for answer_index in range(4):
            payload = generated_payload()
            payload["quizzes"][0]["correct_option"] = (
                payload["quizzes"][0]["options"][answer_index]
            )
            normalized = server.normalize_generated_activities(payload)
            self.assertEqual(normalized["quizzes"][0]["answer"], answer_index)

    def test_generated_attempt_persists_correct_option_and_answer_index_together(self):
        connection = server.initialize_database(self.database_path)
        try:
            lesson = server.catalog_from_database(connection)["lessons"][0]
            payload = generated_payload()
            payload["quizzes"][0]["correct_option"] = payload["quizzes"][0]["options"][2]
            activities = server.normalize_generated_activities(payload)
            attempt_id = server.create_activity_attempt(
                connection, lesson["id"], activities, "generated"
            )

            stored = connection.execute(
                """
                SELECT quiz.answer_index, correct_option.position
                FROM attempt_quizzes quiz
                JOIN attempt_quiz_options correct_option
                    ON correct_option.attempt_id = quiz.attempt_id
                    AND correct_option.quiz_id = quiz.id
                    AND correct_option.is_correct = 1
                WHERE quiz.attempt_id = ? AND quiz.position = 0
                """,
                (attempt_id,),
            ).fetchone()
            self.assertEqual(stored["answer_index"], 2)
            self.assertEqual(stored["position"], 2)
            self.assertEqual(
                server.activities_for_attempt(connection, attempt_id)["quizzes"][0][
                    "answer"
                ],
                2,
            )
        finally:
            connection.close()

    def test_transcript_generation_retries_invalid_display_text_once(self):
        normalized = server.normalize_generated_activities(generated_payload())
        with (
            patch.object(
                server,
                "fetch_youtube_transcript_with_metadata",
                return_value=("Transcript text.", True),
            ) as fetch,
            patch.object(
                server,
                "generate_activities_with_ollama",
                side_effect=[ValueError("answer-shaped text"), normalized],
            ) as generate,
        ):
            activities, excerpted = server.generate_activities_from_transcript(
                "kyQ0CRkYhy4"
            )
        self.assertTrue(excerpted)
        self.assertEqual(len(activities["quizzes"]), 5)
        fetch.assert_called_once_with("kyQ0CRkYhy4")
        self.assertEqual(generate.call_count, 2)

        with (
            patch.object(
                server,
                "fetch_youtube_transcript_with_metadata",
                return_value=("Transcript text.", False),
            ),
            patch.object(
                server,
                "generate_activities_with_ollama",
                side_effect=ValueError("still malformed"),
            ) as generate,
        ):
            with self.assertRaisesRegex(ValueError, "still malformed"):
                server.generate_activities_from_transcript("kyQ0CRkYhy4")
        self.assertEqual(generate.call_count, 2)

    def test_ollama_request_uses_local_chat_api_and_json_schema(self):
        generated = generated_payload()
        response_body = json.dumps(
            {"message": {"content": json.dumps(generated)}}
        ).encode("utf-8")
        response = Mock()
        response.read.return_value = response_body
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        with patch.object(server, "urlopen", return_value=response) as open_url:
            activities = server.generate_activities_with_ollama(
                "A short source transcript.", "llama3.2:latest"
            )

        self.assertEqual(len(activities["quizzes"]), 5)
        request = open_url.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:11434/api/chat")
        payload = json.loads(request.data.decode("utf-8"))
        self.assertEqual(payload["model"], "llama3.2:latest")
        quiz_schema = payload["format"]["properties"]["quizzes"]
        self.assertEqual(quiz_schema["maxItems"], 5)
        self.assertEqual(
            quiz_schema["items"]["properties"]["correct_option"]["type"], "string"
        )
        self.assertIn(
            "correct_option", quiz_schema["items"]["required"]
        )
        self.assertNotIn("answer", quiz_schema["items"]["properties"])

        with patch.object(server, "OLLAMA_BASE_URL", "http://192.168.1.5:11434"):
            with self.assertRaisesRegex(RuntimeError, "loopback"):
                server.generate_activities_with_ollama(
                    "A short source transcript.", "llama3.2:latest"
                )

        with patch.object(server, "urlopen", side_effect=TimeoutError("timed out")):
            with self.assertRaisesRegex(RuntimeError, "request failed"):
                server.generate_activities_with_ollama(
                    "A short source transcript.", "llama3.2:latest"
                )

    def test_video_details_ollama_uses_separate_schema_and_caption_timestamps(self):
        source_segments = [
            {"timestampSeconds": 12, "timestamp": "00:00:12", "text": "Opening."},
            {"timestampSeconds": 48, "timestamp": "00:00:48", "text": "Next idea."},
        ]
        generated = {
            "summary": "A concise overview.",
            "topics": [
                {"title": "Opening", "timestamp": "00:00:12"},
                {"title": "Next idea", "timestamp": "00:00:48"},
            ],
        }
        response_body = json.dumps(
            {"message": {"content": json.dumps(generated)}}
        ).encode("utf-8")
        response = Mock()
        response.read.return_value = response_body
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        with patch.object(server, "urlopen", return_value=response) as open_url:
            details = server.generate_video_details_with_ollama(
                "Lesson captions.", source_segments, "llama3.2:latest"
            )

        payload = json.loads(open_url.call_args.args[0].data.decode("utf-8"))
        detail_schema = payload["format"]
        self.assertEqual(set(detail_schema["properties"]), {"summary", "topics"})
        self.assertEqual(
            detail_schema["properties"]["topics"]["items"]["properties"]["timestamp"][
                "enum"
            ],
            ["00:00:12", "00:00:48"],
        )
        self.assertEqual(
            details,
            {
                "summary": "A concise overview.",
                "topics": [
                    {"title": "Opening", "timestampSeconds": 12},
                    {"title": "Next idea", "timestampSeconds": 48},
                ],
            },
        )

    def test_v1_database_migrates_activity_responses_into_attempt_snapshot(self):
        connection = server.connect_database(self.database_path)
        try:
            connection.executescript(
                """
                CREATE TABLE courses (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
                CREATE TABLE lessons (
                    id INTEGER PRIMARY KEY, course_id INTEGER, sort_order INTEGER,
                    title TEXT, description TEXT, type TEXT, video_id TEXT, src TEXT,
                    legacy_quiz_id TEXT, legacy_reflection_id TEXT
                );
                CREATE TABLE quizzes (
                    id TEXT PRIMARY KEY, lesson_id INTEGER, position INTEGER,
                    question TEXT, answer_index INTEGER, feedback TEXT, UNIQUE(id, lesson_id)
                );
                CREATE TABLE quiz_options (
                    quiz_id TEXT, position INTEGER, option_text TEXT, is_correct INTEGER,
                    PRIMARY KEY(quiz_id, position)
                );
                CREATE TABLE reflections (
                    id TEXT PRIMARY KEY, lesson_id INTEGER, position INTEGER, prompt TEXT,
                    UNIQUE(id, lesson_id)
                );
                CREATE TABLE learners (id INTEGER PRIMARY KEY, created_at TEXT);
                CREATE TABLE learner_state (learner_id INTEGER PRIMARY KEY, current_lesson_id INTEGER);
                CREATE TABLE learner_lesson_state (
                    learner_id INTEGER, lesson_id INTEGER, completed INTEGER,
                    quiz_reveal_count INTEGER, reflection_reveal_count INTEGER,
                    PRIMARY KEY(learner_id, lesson_id)
                );
                CREATE TABLE learner_activity_order (
                    learner_id INTEGER, lesson_id INTEGER, activity_type TEXT,
                    position INTEGER, activity_id TEXT
                );
                CREATE TABLE learner_quiz_responses (
                    learner_id INTEGER, lesson_id INTEGER, quiz_id TEXT,
                    selected_option_index INTEGER
                );
                CREATE TABLE learner_reflection_responses (
                    learner_id INTEGER, lesson_id INTEGER, reflection_id TEXT,
                    response_text TEXT
                );
                INSERT INTO courses VALUES (1, 'Migration test');
                INSERT INTO lessons VALUES (1, 1, 0, 'Lesson', '', 'youtube',
                    'kyQ0CRkYhy4', NULL, NULL, NULL);
                INSERT INTO quizzes VALUES ('q1', 1, 0, 'Question?', 1, 'Correct.');
                INSERT INTO quiz_options VALUES ('q1', 0, 'Wrong', 0);
                INSERT INTO quiz_options VALUES ('q1', 1, 'Right', 1);
                INSERT INTO quizzes VALUES ('q2', 1, 1, 'Another?', 0, 'Correct.');
                INSERT INTO quiz_options VALUES ('q2', 0, 'Right', 1);
                INSERT INTO quiz_options VALUES ('q2', 1, 'Wrong', 0);
                INSERT INTO reflections VALUES ('r1', 1, 0, 'Reflect.');
                INSERT INTO learners VALUES (1, CURRENT_TIMESTAMP);
                INSERT INTO learner_state VALUES (1, 1);
                INSERT INTO learner_lesson_state VALUES (1, 1, 0, 2, 1);
                INSERT INTO learner_activity_order VALUES (1, 1, 'quiz', 0, 'q1');
                INSERT INTO learner_activity_order VALUES (1, 1, 'quiz', 1, 'q2');
                INSERT INTO learner_activity_order VALUES (1, 1, 'reflection', 0, 'r1');
                INSERT INTO learner_quiz_responses VALUES (1, 1, 'q1', 1);
                INSERT INTO learner_reflection_responses VALUES (1, 1, 'r1', 'Saved.');
                PRAGMA user_version = 1;
                """
            )
            connection.close()

            migrated = server.initialize_database(
                self.database_path
            )
            try:
                progress = server.progress_from_database(migrated)
                self.assertEqual(progress["lessons"][0]["quizAnswers"], {"q1": 1})
                self.assertEqual(progress["lessons"][0]["reflections"], {"r1": "Saved."})
                self.assertEqual(
                    migrated.execute("PRAGMA user_version").fetchone()[0], 9
                )
                self.assertIsNotNone(
                    migrated.execute(
                        "SELECT name FROM sqlite_master "
                        "WHERE type = 'table' AND name = 'transcript_cache'"
                    ).fetchone()
                )
                self.assertEqual(migrated.execute("PRAGMA foreign_key_check").fetchall(), [])
            finally:
                migrated.close()
        finally:
            if connection:
                connection.close()

    def test_v5_database_migrates_to_transcript_cache_without_data_loss(self):
        connection = server.initialize_database(self.database_path)
        expected_lesson_count = connection.execute(
            "SELECT COUNT(*) FROM lessons"
        ).fetchone()[0]
        with connection:
            connection.execute("DROP TABLE transcript_cache")
            connection.execute("DROP TABLE video_details")
            connection.execute("DROP TABLE learner_media_progress")
            connection.execute("PRAGMA user_version = 5")
        connection.close()

        migrated = server.initialize_database(self.database_path)
        try:
            self.assertEqual(
                migrated.execute("PRAGMA user_version").fetchone()[0], 9
            )
            self.assertEqual(
                migrated.execute("SELECT COUNT(*) FROM lessons").fetchone()[0],
                expected_lesson_count,
            )
            self.assertIsNotNone(
                migrated.execute(
                    "SELECT name FROM sqlite_master "
                    "WHERE type = 'table' AND name = 'transcript_cache'"
                ).fetchone()
            )
            self.assertIsNotNone(
                migrated.execute(
                    "SELECT name FROM sqlite_master "
                    "WHERE type = 'table' AND name = 'video_details'"
                ).fetchone()
            )
        finally:
            migrated.close()

    def test_v6_database_migrates_video_details_without_data_loss(self):
        connection = server.initialize_database(self.database_path)
        expected_lesson_count = connection.execute(
            "SELECT COUNT(*) FROM lessons"
        ).fetchone()[0]
        with connection:
            connection.execute("DROP TABLE video_details")
            connection.execute("DROP TABLE learner_media_progress")
            connection.execute("PRAGMA user_version = 6")
        connection.close()

        migrated = server.initialize_database(self.database_path)
        try:
            self.assertEqual(
                migrated.execute("PRAGMA user_version").fetchone()[0], 9
            )
            self.assertEqual(
                migrated.execute("SELECT COUNT(*) FROM lessons").fetchone()[0],
                expected_lesson_count,
            )
            self.assertIsNotNone(
                migrated.execute(
                    "SELECT name FROM sqlite_master "
                    "WHERE type = 'table' AND name = 'video_details'"
                ).fetchone()
            )
        finally:
            migrated.close()

    def test_v7_database_migrates_playback_positions_without_data_loss(self):
        connection = server.initialize_database(self.database_path)
        original_description = connection.execute(
            "SELECT description FROM lessons WHERE id = 1"
        ).fetchone()[0]
        original_quiz_count = connection.execute(
            "SELECT COUNT(*) FROM quizzes"
        ).fetchone()[0]
        video_id = connection.execute(
            "SELECT video_id FROM lessons WHERE id = 1"
        ).fetchone()[0]
        details = {
            "summary": "Existing summary.",
            "topics": [{"title": "Opening", "timestampSeconds": 0}],
        }
        with connection:
            connection.execute(
                "INSERT INTO video_details (video_id, details_json) VALUES (?, ?)",
                (video_id, json.dumps(details)),
            )
            connection.execute("PRAGMA user_version = 7")
            connection.execute("DROP TABLE learner_media_progress")
        connection.close()

        migrated = server.initialize_database(self.database_path)
        try:
            self.assertEqual(
                migrated.execute("PRAGMA user_version").fetchone()[0], 9
            )
            self.assertEqual(
                migrated.execute(
                    "SELECT description FROM lessons WHERE id = 1"
                ).fetchone()[0],
                original_description,
            )
            self.assertEqual(
                migrated.execute("SELECT COUNT(*) FROM quizzes").fetchone()[0],
                original_quiz_count,
            )
            self.assertEqual(
                server.load_video_details(migrated, video_id), details
            )
            self.assertIsNone(server.load_playback_position(migrated, 1))
        finally:
            migrated.close()

    def test_generated_attempts_are_stable_and_reattempt_resets_only_current_lesson(self):
        connection = server.initialize_database(
            self.database_path
        )
        try:
            catalog = server.catalog_from_database(connection)
            lesson_id = catalog["lessons"][0]["id"]
            with patch.object(
                server,
                "generate_activities_from_transcript",
                return_value=(
                    server.normalize_generated_activities(generated_payload()),
                    False,
                ),
            ) as generate:
                first = server.start_activity_attempt(connection, lesson_id, "start")
                repeated = server.start_activity_attempt(connection, lesson_id, "start")
                self.assertEqual(first["attempt"]["source"], "generated")
                self.assertEqual(first["attempt"]["attemptId"], repeated["attempt"]["attemptId"])
                self.assertGreaterEqual(
                    first["attempt"]["generationDurationSeconds"], 0
                )
                self.assertEqual(
                    repeated["attempt"]["generationDurationSeconds"],
                    first["attempt"]["generationDurationSeconds"],
                )
                generate.assert_called_once_with(
                    catalog["lessons"][0]["videoId"], connection=connection
                )

                progress = first["progress"]
                progress["activityDecks"][lesson_id]["quizOrder"] = [
                    quiz["id"] for quiz in first["attempt"]["activities"]["quizzes"]
                ]
                progress["activityDecks"][lesson_id]["reflectionOrder"] = [
                    item["id"] for item in first["attempt"]["activities"]["reflections"]
                ]
                progress["lessons"][0]["quizAnswers"] = {
                    progress["activityDecks"][lesson_id]["quizOrder"][0]: 0
                }
                progress["lessons"][0]["reflections"] = {
                    progress["activityDecks"][lesson_id]["reflectionOrder"][0]: "Saved."
                }
                server.save_progress(connection, progress)

                second = server.start_activity_attempt(
                    connection, lesson_id, "reattempt"
                )
                self.assertNotEqual(first["attempt"]["attemptId"], second["attempt"]["attemptId"])
                self.assertEqual(second["progress"]["lessons"][0]["quizAnswers"], {})
                self.assertEqual(second["progress"]["lessons"][0]["reflections"], {})
                self.assertEqual(len(second["attempt"]["activities"]["quizzes"]), 5)
                self.assertEqual(len(second["attempt"]["activities"]["reflections"]), 2)
        finally:
            connection.close()

    def test_automatic_generation_preserves_catalog_activities_with_saved_responses(self):
        connection = server.initialize_database(
            self.database_path
        )
        try:
            lesson = server.catalog_from_database(connection)["lessons"][0]
            active_attempt_id = connection.execute(
                """
                SELECT active_attempt_id FROM lesson_activity_state
                WHERE lesson_id = ?
                """,
                (lesson["id"],),
            ).fetchone()[0]
            quiz_id = connection.execute(
                """
                SELECT id FROM attempt_quizzes
                WHERE attempt_id = ? ORDER BY position LIMIT 1
                """,
                (active_attempt_id,),
            ).fetchone()[0]
            with connection:
                connection.execute(
                    """
                    INSERT INTO learner_attempt_quiz_responses (
                        learner_id, lesson_id, attempt_id, quiz_id,
                        selected_option_index
                    ) VALUES (1, ?, ?, ?, 0)
                    """,
                    (lesson["id"], active_attempt_id, quiz_id),
                )

            with patch.object(server, "generate_activities_from_transcript") as generate:
                result = server.start_activity_attempt(
                    connection, lesson["id"], "start"
                )

            self.assertEqual(result["attempt"]["source"], "catalog")
            self.assertIn("saved responses", result["attempt"]["skippedReason"])
            self.assertEqual(result["attempt"]["attemptId"], active_attempt_id)
            generate.assert_not_called()
        finally:
            connection.close()

    def test_generation_failure_persists_status_without_fallback_activities(self):
        connection = server.initialize_database(
            self.database_path
        )
        try:
            lesson = server.catalog_from_database(connection)["lessons"][0]
            with patch.object(
                server,
                "generate_activities_from_transcript",
                side_effect=[
                    RuntimeError("captions are unavailable"),
                    (server.normalize_generated_activities(generated_payload()), False),
                ],
            ) as generate:
                first = server.start_activity_attempt(connection, lesson["id"], "start")
                repeated = server.start_activity_attempt(connection, lesson["id"], "start")
                self.assertEqual(generate.call_count, 1)
                retried = server.start_activity_attempt(
                    connection, lesson["id"], "retry"
                )
            self.assertIsNone(first["attempt"])
            self.assertEqual(first["generationState"]["status"], "failed")
            self.assertIn(
                "captions are unavailable",
                first["generationState"]["failureReason"],
            )
            self.assertEqual(repeated["generationState"]["status"], "failed")
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM activity_attempts WHERE source = 'fallback'"
                ).fetchone()[0],
                0,
            )
            self.assertEqual(retried["attempt"]["source"], "generated")
            self.assertIsNone(retried["generationState"])
            self.assertEqual(generate.call_count, 2)
        finally:
            connection.close()

    def test_caption_sentence_index_retains_original_timing_after_cleanup(self):
        sentences = server.build_caption_sentence_index(
            [
                SimpleNamespace(
                    text="Um, first topic starts here. Still the first topic.",
                    start=2.8,
                    duration=4.2,
                ),
                SimpleNamespace(
                    text="Uh, a new idea begins now.",
                    start=19.4,
                    duration=3.0,
                ),
            ]
        )
        self.assertEqual(
            [(sentence["sentenceId"], sentence["timestampSeconds"]) for sentence in sentences],
            [(0, 2.8), (1, 2.8), (2, 19.4)],
        )
        self.assertEqual(
            [sentence["text"] for sentence in sentences],
            [
                "first topic starts here.",
                "Still the first topic.",
                "a new idea begins now.",
            ],
        )

    def test_semantic_chapter_boundaries_map_to_original_caption_times(self):
        sentence_index = server.build_caption_sentence_index(
            [
                SimpleNamespace(text="Opening sentence.", start=0, duration=2),
                SimpleNamespace(text="Opening continues.", start=8, duration=2),
                SimpleNamespace(text="New topic begins.", start=24, duration=3),
            ]
        )
        chapters = server.normalize_semantic_chapter_boundaries(
            {
                "chapters": [
                    {"start_sentence_id": 0, "title": "Introduction"},
                    {"start_sentence_id": 2, "title": "Main topic"},
                ]
            },
            sentence_index,
        )
        self.assertEqual(
            chapters,
            [
                {"title": "Introduction", "timestampSeconds": 0.0},
                {"title": "Main topic", "timestampSeconds": 24.0},
            ],
        )

    def test_semantic_chapter_validation_rejects_repeated_time_and_nonzero_start(self):
        sentence_index = server.build_caption_sentence_index(
            [
                SimpleNamespace(text="First sentence.", start=0, duration=10),
                SimpleNamespace(text="Second sentence.", start=0, duration=10),
                SimpleNamespace(text="Third sentence.", start=15, duration=5),
            ]
        )
        with self.assertRaisesRegex(ValueError, "strictly chronological"):
            server.normalize_semantic_chapter_boundaries(
                {
                    "chapters": [
                        {"start_sentence_id": 0, "title": "Opening"},
                        {"start_sentence_id": 1, "title": "Repeated time"},
                    ]
                },
                sentence_index,
            )
        with self.assertRaisesRegex(ValueError, "sentence ID 0"):
            server.normalize_semantic_chapter_boundaries(
                {"chapters": [{"start_sentence_id": 2, "title": "Late start"}]},
                sentence_index,
            )

    def test_semantic_chapter_generation_corrects_invalid_boundaries_once(self):
        segments = [
            SimpleNamespace(text="Opening sentence.", start=0, duration=5),
            SimpleNamespace(text="Next sentence.", start=15, duration=5),
        ]
        responses = []
        for generated in (
            {
                "chapters": [
                    {"start_sentence_id": 0, "title": "Opening"},
                    {"start_sentence_id": 0, "title": "Repeated"},
                ]
            },
            {
                "chapters": [
                    {"start_sentence_id": 0, "title": "Opening"},
                    {"start_sentence_id": 1, "title": "Next topic"},
                ]
            },
        ):
            response = Mock()
            response.read.return_value = json.dumps(
                {"message": {"content": json.dumps(generated)}}
            ).encode("utf-8")
            response.__enter__ = Mock(return_value=response)
            response.__exit__ = Mock(return_value=False)
            responses.append(response)

        with patch.object(server, "urlopen", side_effect=responses) as open_url:
            chapters = server.generate_semantic_video_chapters(
                segments, "llama3.2:latest"
            )
        self.assertEqual(
            chapters,
            [
                {"title": "Opening", "timestampSeconds": 0},
                {"title": "Next topic", "timestampSeconds": 15},
            ],
        )
        self.assertEqual(open_url.call_count, 2)
        retry_payload = json.loads(open_url.call_args_list[1].args[0].data)
        self.assertIn(
            "Correct these validation errors",
            retry_payload["messages"][1]["content"],
        )

    def test_semantic_chapter_generation_reports_failure_after_correction(self):
        segments = [
            SimpleNamespace(text="Opening sentence.", start=0, duration=5),
            SimpleNamespace(text="Next sentence.", start=15, duration=5),
        ]
        invalid = {
            "chapters": [
                {"start_sentence_id": 1, "title": "Starts too late"},
            ]
        }
        responses = []
        for _ in range(2):
            response = Mock()
            response.read.return_value = json.dumps(
                {"message": {"content": json.dumps(invalid)}}
            ).encode("utf-8")
            response.__enter__ = Mock(return_value=response)
            response.__exit__ = Mock(return_value=False)
            responses.append(response)

        with patch.object(server, "urlopen", side_effect=responses) as open_url:
            with self.assertRaisesRegex(RuntimeError, "failed validation after correction"):
                server.generate_semantic_video_chapters(
                    segments, "llama3.2:latest"
                )
        self.assertEqual(open_url.call_count, 2)

    def test_video_explainer_context_adapts_around_time_and_samples_full_video(self):
        segments = [
            SimpleNamespace(
                text=(
                    f"Topic {index} begins. "
                    f"Detail {index} explains the concept in context. "
                    + ("This caption adds useful background information. " * 9)
                ),
                start=index * 30,
                duration=8,
            )
            for index in range(12)
        ]

        context = server.build_video_explainer_context(segments, 180)

        self.assertIn("[00:03:00] Topic 6 begins.", context["nearbyCaptions"])
        self.assertIn("[00:00:00] Topic 0 begins.", context["wholeVideoCaptions"])
        self.assertIn("[00:05:30] Topic 11 begins.", context["wholeVideoCaptions"])
        self.assertLessEqual(
            len(context["nearbyCaptions"]),
            server.VIDEO_EXPLAINER_LOCAL_CONTEXT_CHARACTERS,
        )
        self.assertLessEqual(
            len(context["wholeVideoCaptions"]),
            server.VIDEO_EXPLAINER_GLOBAL_CONTEXT_CHARACTERS,
        )
        self.assertEqual(context["timestampSeconds"], 180.0)

    def test_video_explainer_uses_cached_captions_and_does_not_save_explanation(self):
        connection = server.initialize_database(self.database_path)
        segments = [
            SimpleNamespace(text="Opening idea.", start=0, duration=5),
            SimpleNamespace(text="A detailed explanation of this moment.", start=30, duration=8),
            SimpleNamespace(text="Later idea.", start=90, duration=5),
        ]
        response = Mock()
        response.read.return_value = json.dumps(
            {
                "message": {
                    "content": json.dumps(
                        {"explanation": "This moment develops the opening idea."}
                    )
                }
            }
        ).encode("utf-8")
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        try:
            with connection:
                connection.execute(
                    "INSERT INTO video_details (video_id, details_json) VALUES (?, ?)",
                    (
                        "kyQ0CRkYhy4",
                        json.dumps(
                            {
                                "summary": "The video explains a core learning concept.",
                                "topics": [
                                    {"title": "Opening", "timestampSeconds": 0}
                                ],
                            }
                        ),
                    ),
                )
            details_count_before = connection.execute(
                "SELECT COUNT(*) FROM video_details"
            ).fetchone()[0]
            with (
                patch.object(
                    server,
                    "cached_or_fetch_youtube_segments",
                    return_value=segments,
                ) as get_segments,
                patch.object(server, "urlopen", return_value=response) as open_url,
            ):
                explanation = server.generate_video_explanation(
                    connection, "kyQ0CRkYhy4", 32.5
                )

            self.assertEqual(
                explanation, "This moment develops the opening idea."
            )
            get_segments.assert_called_once_with(connection, "kyQ0CRkYhy4")
            request_payload = json.loads(open_url.call_args.args[0].data)
            prompt = request_payload["messages"][1]["content"]
            self.assertIn("ACTIVE VIDEO TIME: 00:00:32", prompt)
            self.assertIn("A detailed explanation of this moment.", prompt)
            self.assertIn("Opening idea.", prompt)
            self.assertIn(
                "The video explains a core learning concept.", prompt
            )
            self.assertEqual(request_payload["options"]["num_predict"], 300)
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM video_details"
                ).fetchone()[0],
                details_count_before,
            )
        finally:
            connection.close()

    def test_video_explainer_rejects_invalid_timestamp_and_empty_output(self):
        connection = server.initialize_database(self.database_path)
        segments = [
            SimpleNamespace(text="Only caption.", start=0, duration=5),
        ]
        try:
            with patch.object(
                server,
                "cached_or_fetch_youtube_segments",
                return_value=segments,
            ):
                for timestamp in (-1, float("nan"), float("inf"), True, "2", 6):
                    with self.subTest(timestamp=timestamp):
                        with self.assertRaises(ValueError):
                            server.generate_video_explanation(
                                connection, "kyQ0CRkYhy4", timestamp
                            )

                response = Mock()
                response.read.return_value = json.dumps(
                    {"message": {"content": json.dumps({"explanation": "  "})}}
                ).encode("utf-8")
                response.__enter__ = Mock(return_value=response)
                response.__exit__ = Mock(return_value=False)
                with patch.object(server, "urlopen", return_value=response):
                    with self.assertRaisesRegex(RuntimeError, "empty explanation"):
                        server.generate_video_explanation(
                            connection, "kyQ0CRkYhy4", 2
                        )
        finally:
            connection.close()

    def test_video_explainer_ends_at_last_complete_sentence(self):
        self.assertEqual(
            server.complete_explainer_sentence(
                "The first idea is clear. The second idea is still being explained"
            ),
            "The first idea is clear.",
        )
        self.assertEqual(
            server.complete_explainer_sentence("A complete answer!"),
            "A complete answer!",
        )
        self.assertEqual(
            server.complete_explainer_sentence("An unfinished answer"),
            "",
        )

    def test_new_lesson_chapter_pipeline_keeps_source_chapters_and_separate_summary(self):
        connection = server.initialize_database(self.database_path)
        video_id = "kyQ0CRkYhy4"
        segments = [
            SimpleNamespace(text="Opening.", start=0, duration=10),
            SimpleNamespace(text="Next.", start=20, duration=10),
        ]
        chapters = [
            {"title": "Opening", "timestampSeconds": 0},
            {"title": "Next", "timestampSeconds": 20},
        ]
        try:
            with (
                patch.object(server, "fetch_youtube_chapters", return_value=chapters),
                patch.object(server, "cached_or_fetch_youtube_segments", return_value=segments),
                patch.object(
                    server,
                    "generate_video_details_with_ollama",
                    return_value={"summary": "A concise overview.", "topics": []},
                ) as summary_generation,
                patch.object(server, "generate_semantic_video_chapters") as semantic_generation,
            ):
                details = server.ensure_video_details(
                    connection, video_id, new_lesson=True
                )

            self.assertEqual(details["topics"], chapters)
            summary_generation.assert_called_once()
            self.assertEqual(summary_generation.call_args.args[1], [])
            semantic_generation.assert_not_called()
        finally:
            connection.close()

    def test_new_lesson_without_native_chapters_uses_semantic_pipeline(self):
        connection = server.initialize_database(self.database_path)
        video_id = "kyQ0CRkYhy4"
        segments = [
            SimpleNamespace(text="Opening.", start=0, duration=10),
            SimpleNamespace(text="A new topic.", start=20, duration=10),
        ]
        chapters = [
            {"title": "Introduction", "timestampSeconds": 0},
            {"title": "New topic", "timestampSeconds": 20},
        ]
        try:
            with (
                patch.object(server, "fetch_youtube_chapters", return_value=[]),
                patch.object(server, "cached_or_fetch_youtube_segments", return_value=segments),
                patch.object(
                    server,
                    "generate_video_details_with_ollama",
                    return_value={"summary": "A concise overview.", "topics": []},
                ),
                patch.object(
                    server,
                    "generate_semantic_video_chapters",
                    return_value=chapters,
                ) as semantic_generation,
            ):
                details = server.ensure_video_details(
                    connection, video_id, new_lesson=True
                )
            self.assertEqual(details["topics"], chapters)
            semantic_generation.assert_called_once_with(segments, server.OLLAMA_MODEL)
        finally:
            connection.close()

    def test_failed_reattempt_restores_previous_generated_non_generic_set(self):
        connection = server.initialize_database(self.database_path)
        try:
            lesson = server.catalog_from_database(connection)["lessons"][0]
            with patch.object(
                server,
                "generate_activities_from_transcript",
                return_value=(
                    server.normalize_generated_activities(generated_payload()),
                    False,
                ),
            ):
                original = server.start_activity_attempt(
                    connection, lesson["id"], "start"
                )
            with patch.object(
                server,
                "generate_activities_from_transcript",
                side_effect=RuntimeError("Ollama is unavailable"),
            ):
                failed = server.start_activity_attempt(
                    connection, lesson["id"], "reattempt"
                )

            self.assertEqual(failed["generationState"]["status"], "failed")
            self.assertEqual(
                failed["attempt"]["attemptId"], original["attempt"]["attemptId"]
            )
            self.assertEqual(failed["attempt"]["source"], "generated")
            self.assertEqual(len(failed["attempt"]["activities"]["quizzes"]), 5)
        finally:
            connection.close()

    def test_generic_activities_are_filtered_from_catalog_and_attempt_reads(self):
        connection = server.initialize_database(self.database_path)
        try:
            catalog = server.catalog_from_database(connection)
            lesson = catalog["lessons"][0]
            generic_activities = {
                "quizzes": [
                    {
                        "id": f"quiz-lesson-{lesson['id']}-summarize",
                        "question": "What is a useful way to learn from a video lesson?",
                        "options": ["Summarize", "Skip"],
                        "answer": 0,
                        "feedback": "Summarizing helps.",
                    }
                ],
                "reflections": [
                    {
                        "id": f"reflection-lesson-{lesson['id']}-takeaway",
                        "prompt": "What is one idea from this video that you would like to explore further?",
                    }
                ],
            }
            lesson["activities"] = generic_activities
            with connection:
                server.save_catalog(connection, catalog)
                attempt_id = server.create_activity_attempt(
                    connection, lesson["id"], generic_activities, "catalog"
                )
                connection.execute(
                    """
                    UPDATE lesson_activity_state SET active_attempt_id = ?
                    WHERE lesson_id = ?
                    """,
                    (attempt_id, lesson["id"]),
                )

            catalog_activities = server.catalog_from_database(connection)["lessons"][0][
                "activities"
            ]
            attempt_activities = server.activities_for_attempt(connection, attempt_id)
            self.assertEqual(catalog_activities, {"quizzes": [], "reflections": []})
            self.assertEqual(attempt_activities, {"quizzes": [], "reflections": []})
            self.assertNotIn(
                str(lesson["id"]), server.active_attempts_from_database(connection)
            )
        finally:
            connection.close()


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.original_database_path = server.DATABASE_PATH
        server.DATABASE_PATH = Path(self.temporary_directory.name) / "learning.sqlite3"
        connection = server.initialize_database(
            server.DATABASE_PATH
        )
        connection.close()
        self.http_server = ThreadingHTTPServer(
            ("127.0.0.1", 0), server.CourseRequestHandler
        )
        self.thread = threading.Thread(target=self.http_server.serve_forever)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.http_server.server_port}"

    def tearDown(self):
        self.http_server.shutdown()
        self.http_server.server_close()
        self.thread.join()
        server.DATABASE_PATH = self.original_database_path
        self.temporary_directory.cleanup()

    def request_json(self, path, method="GET", payload=None):
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = Request(
            f"{self.base_url}{path}",
            data=body,
            method=method,
            headers={"Content-Type": "application/json"} if body else {},
        )
        with urlopen(request) as response:
            return json.loads(response.read().decode("utf-8"))

    def test_progress_import_is_idempotent_and_api_reads_sqlite_content(self):
        response = self.request_json("/api/catalog")
        self.assertEqual(len(response["catalog"]["lessons"]), 5)
        progress = server.empty_progress(response["catalog"])
        lesson = response["catalog"]["lessons"][0]
        deck = progress["activityDecks"][lesson["id"]]
        deck["quizOrder"] = [
            quiz["id"] for quiz in lesson["activities"]["quizzes"]
        ]
        deck["reflectionOrder"] = [
            reflection["id"] for reflection in lesson["activities"]["reflections"]
        ]
        progress["lessons"][0]["quizAnswers"] = {
            quiz_id: 0 for quiz_id in deck["quizOrder"][:2]
        }
        progress["lessons"][0]["reflections"] = {
            deck["reflectionOrder"][0]: "Saved through the API."
        }
        progress["lessons"][0]["completed"] = True
        imported = self.request_json(
            "/api/progress/import", method="POST", payload=progress
        )
        self.assertTrue(imported["imported"])
        self.assertTrue(imported["progress"]["lessons"][0]["completed"])
        self.assertEqual(
            imported["progress"]["lessons"][0]["reflections"][
                deck["reflectionOrder"][0]
            ],
            "Saved through the API.",
        )

        changed_progress = {**progress, "currentModuleId": response["catalog"]["lessons"][1]["id"]}
        second_import = self.request_json(
            "/api/progress/import", method="POST", payload=changed_progress
        )
        self.assertFalse(second_import["imported"])
        self.assertEqual(
            second_import["progress"]["currentModuleId"], progress["currentModuleId"]
        )
        updated = self.request_json(
            "/api/progress", method="PUT", payload=changed_progress
        )
        self.assertEqual(updated["progress"]["currentModuleId"], changed_progress["currentModuleId"])

    def test_video_title_api_validates_id_and_returns_youtube_metadata(self):
        with patch.object(
            server, "fetch_youtube_video_title", return_value="A video title"
        ) as fetch_title:
            result = self.request_json("/api/video-title?videoId=kyQ0CRkYhy4")
        self.assertEqual(result["title"], "A video title")
        fetch_title.assert_called_once_with("kyQ0CRkYhy4")

        with self.assertRaises(HTTPError) as error:
            urlopen(f"{self.base_url}/api/video-title?videoId=invalid")
        self.assertEqual(error.exception.code, 400)

    def test_video_details_api_routes_new_lesson_chapter_processing_separately(self):
        details = {
            "summary": "A concise overview.",
            "topics": [{"title": "Main topic", "timestampSeconds": 45}],
        }
        with patch.object(server, "ensure_video_details", return_value=details) as ensure:
            result = self.request_json(
                "/api/video-details",
                method="POST",
                payload={"videoId": "kyQ0CRkYhy4", "newLesson": True},
            )
        self.assertEqual(result, {"videoId": "kyQ0CRkYhy4", "details": details})
        ensure.assert_called_once_with(
            ANY,
            "kyQ0CRkYhy4",
            new_lesson=True,
        )

        with self.assertRaises(HTTPError) as error:
            self.request_json(
                "/api/video-details",
                method="POST",
                payload={"videoId": "invalid"},
            )
        self.assertEqual(error.exception.code, 400)

    def test_video_explainer_api_validates_and_returns_ephemeral_explanation(self):
        explanation = "This is the idea being explained at the current moment."
        with patch.object(
            server,
            "generate_video_explanation",
            return_value=explanation,
        ) as generate:
            result = self.request_json(
                "/api/video-explainer",
                method="POST",
                payload={
                    "videoId": "kyQ0CRkYhy4",
                    "timestampSeconds": 24.5,
                },
            )
        self.assertEqual(
            result,
            {
                "videoId": "kyQ0CRkYhy4",
                "timestampSeconds": 24.5,
                "explanation": explanation,
            },
        )
        generate.assert_called_once_with(ANY, "kyQ0CRkYhy4", 24.5)

        with self.assertRaises(HTTPError) as error:
            self.request_json(
                "/api/video-explainer",
                method="POST",
                payload={"videoId": "invalid", "timestampSeconds": 24.5},
            )
        self.assertEqual(error.exception.code, 400)

        with self.assertRaises(HTTPError) as error:
            self.request_json(
                "/api/video-explainer",
                method="POST",
                payload={"videoId": "kyQ0CRkYhy4", "timestampSeconds": True},
            )
        self.assertEqual(error.exception.code, 400)

    def test_catalog_api_saves_course_and_lesson_title_edits(self):
        catalog = self.request_json("/api/catalog")["catalog"]
        self.assertTrue(
            all("description" not in lesson for lesson in catalog["lessons"])
        )
        catalog["title"] = "  Updated course title  "
        catalog["lessons"][0]["title"] = "  Updated lesson title  "

        self.request_json("/api/catalog", method="PUT", payload=catalog)
        saved = self.request_json("/api/catalog")["catalog"]

        self.assertEqual(saved["title"], "Updated course title")
        self.assertEqual(saved["lessons"][0]["title"], "Updated lesson title")

    def test_playback_position_api_round_trips_and_validates(self):
        lesson_id = self.request_json("/api/catalog")["catalog"]["lessons"][0]["id"]
        position = self.request_json(
            "/api/playback-position",
            method="PUT",
            payload={"lessonId": lesson_id, "positionSeconds": 68.375},
        )["position"]
        self.assertEqual(position["lessonId"], lesson_id)
        self.assertEqual(position["positionSeconds"], 68.375)

        loaded = self.request_json(
            f"/api/playback-position?lessonId={lesson_id}"
        )["position"]
        self.assertEqual(loaded, position)
        self.assertIsNone(
            self.request_json(
                f"/api/playback-position?lessonId={lesson_id + 1}"
            )["position"]
        )

        with self.assertRaises(HTTPError) as error:
            self.request_json(
                "/api/playback-position",
                method="PUT",
                payload={"lessonId": lesson_id, "positionSeconds": -1},
            )
        self.assertEqual(error.exception.code, 400)

    def test_activity_attempt_api_returns_saved_generated_snapshot(self):
        catalog = self.request_json("/api/catalog")["catalog"]
        lesson = catalog["lessons"][0]
        generated = server.normalize_generated_activities(generated_payload())
        with patch.object(
            server,
            "generate_activities_from_transcript",
            return_value=(generated, False),
        ) as generate:
            result = self.request_json(
                "/api/activity-attempt",
                method="POST",
                payload={"lessonId": lesson["id"], "mode": "start"},
            )

        self.assertEqual(result["attempt"]["source"], "generated")
        self.assertEqual(len(result["attempt"]["activities"]["quizzes"]), 5)
        self.assertEqual(len(result["attempt"]["activities"]["reflections"]), 2)
        self.assertTrue(result["attempt"]["resetResponses"])
        self.assertGreaterEqual(
            result["attempt"]["generationDurationSeconds"], 0
        )
        generate.assert_called_once_with(
            lesson["videoId"], connection=ANY
        )

        loaded = self.request_json("/api/catalog")
        self.assertEqual(loaded["generationStates"], {})
        self.assertEqual(
            loaded["attempts"][str(lesson["id"])]["attemptId"],
            result["attempt"]["attemptId"],
        )
        self.assertEqual(
            loaded["attempts"][str(lesson["id"])]["generationDurationSeconds"],
            result["attempt"]["generationDurationSeconds"],
        )

    def test_catalog_api_reports_pending_generation_and_hides_old_attempt(self):
        connection = server.connect_database(server.DATABASE_PATH)
        try:
            lesson_id = server.catalog_from_database(connection)["lessons"][0]["id"]
            previous_attempt_id = connection.execute(
                """
                SELECT active_attempt_id FROM lesson_activity_state
                WHERE lesson_id = ?
                """,
                (lesson_id,),
            ).fetchone()[0]
            with connection:
                connection.execute(
                    """
                    INSERT INTO lesson_activity_generation (
                        lesson_id, status, mode, previous_attempt_id
                    ) VALUES (?, 'pending', 'reattempt', ?)
                    """,
                    (lesson_id, previous_attempt_id),
                )
        finally:
            connection.close()

        result = self.request_json("/api/catalog")
        self.assertEqual(
            result["generationStates"][str(lesson_id)]["status"], "pending"
        )
        self.assertNotIn(str(lesson_id), result["attempts"])


if __name__ == "__main__":
    unittest.main()
