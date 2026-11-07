const categories = ["All courses", "AI courses", "News", "Legal", "Business"];
let courses = [];
let selectedCategory = "All courses";

const categoryList = document.getElementById("categoryList");
const categoryHeading = document.getElementById("categoryHeading");
const courseGrid = document.getElementById("courseGrid");
const courseForm = document.getElementById("courseForm");
const formStatus = document.getElementById("formStatus");
const categoryInput = document.getElementById("courseCategoryInput");

function renderCategories() {
  categoryList.replaceChildren();
  categories.forEach((category) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = category;
    button.className = category === selectedCategory ? "is-selected" : "";
    button.addEventListener("click", () => {
      selectedCategory = category;
      renderCategories();
      renderCourses();
    });
    categoryList.append(button);
  });
}

function renderCourses() {
  categoryHeading.textContent = selectedCategory;
  courseGrid.replaceChildren();
  const visibleCourses =
    selectedCategory === "All courses"
      ? courses
      : courses.filter((course) => course.category === selectedCategory);
  if (!visibleCourses.length) {
    const empty = document.createElement("p");
    empty.className = "catalog-empty";
    empty.textContent = "No courses in this category yet.";
    courseGrid.append(empty);
    return;
  }
  visibleCourses.forEach((course, index) => {
    const card = document.createElement("a");
    card.className = "course-card";
    card.href = `course.html?courseId=${encodeURIComponent(course.id)}`;
    card.style.setProperty("--card-index", index);
    card.innerHTML = `
      <div class="course-card-image" aria-hidden="true">
        <span>${course.category}</span>
      </div>
      <div class="course-card-content">
        <p class="course-card-category">${course.category}</p>
        <h3>${escapeHtml(course.title)}</h3>
        <p>${course.lessonCount} lesson${course.lessonCount === 1 ? "" : "s"}</p>
        ${course.expectedDuration ? `<p>${course.expectedDuration}</p>` : ""}
      </div>`;
    courseGrid.append(card);
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function loadCourses() {
  const response = await fetch("/api/courses", { cache: "no-store" });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error ?? "Courses could not be loaded.");
  }
  courses = result.courses;
  renderCategories();
  renderCourses();
}

document.getElementById("addCourseButton").addEventListener("click", () => {
  courseForm.hidden = false;
  document.getElementById("courseTitleInput").focus();
});
document.getElementById("cancelCourseButton").addEventListener("click", () => {
  courseForm.reset();
  courseForm.hidden = true;
  formStatus.textContent = "";
});
categoryInput.replaceChildren(
  ...categories.slice(1).map((category) => new Option(category, category))
);
courseForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  formStatus.textContent = "Creating course…";
  const payload = {
    title: document.getElementById("courseTitleInput").value,
    category: categoryInput.value
  };
  try {
    const response = await fetch("/api/courses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Course could not be created.");
    courses.push(result.course);
    courseForm.reset();
    courseForm.hidden = true;
    formStatus.textContent = "";
    renderCourses();
  } catch (error) {
    formStatus.textContent = error instanceof Error ? error.message : "Course could not be created.";
  }
});
loadCourses().catch((error) => {
  courseGrid.textContent = error instanceof Error ? error.message : "Courses could not be loaded.";
});
