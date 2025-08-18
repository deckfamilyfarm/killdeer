# Business Entity Diagram

This repository is the canonical source for visualizing our business ecosystem — including entities, sales outlets, wholesale channels, and end customers. It is intended as both a documentation tool and a basis for automation using structured data and diagramming tools.

---


## 📌 Purpose

- To document and maintain a clear visual map of our business entities and relationships.
- To provide **machine-readable** data (JSON) that can be rendered programmatically using **Mermaid.js** and **Draw.io (diagrams.net)**.
- To evolve from a **hand-drawn conceptual sketch** to a **maintainable, version-controlled visualization system**.

---
## 📌 How to Run
There is a script to package up the output and create a single `entities.html` file to run in the killdeer github pages environment.
You will need to commit this file under killdeer separately after running the script

```
node build-entities-html.js
```

---
## 📂 Structure

```
docs/
└── entity_diagram.pdf       # Original hand-drawn sketch (reference map)

data/
└── entities.json            # (Planned) JSON data model for entities and relationships

output/
└── diagram.drawio           # (Planned) Editable Draw.io file
└── diagram.mmd              # (Planned) Mermaid.js flow diagram
└── diagram.svg              # (Planned) Rendered output
```

---

## ✅ Goals

- [x] Import hand-drawn entity map as starting reference
- [ ] Define all business entities and relationships in `entities.json`
- [ ] Generate a clean, readable diagram in **Draw.io**
- [ ] Provide an automated rendering using **Mermaid.js**
- [ ] Keep diagram outputs (SVG, PDF) updated via script

---

## 🛠 Tools & Standards

| Tool        | Purpose                                   |
|-------------|-------------------------------------------|
| `Draw.io`   | Visual editor for business relationship map |
| `Mermaid.js`| Code-based diagrams for docs and automation |
| `JSON`      | Single source of truth for entities and links |
| `SVG/PDF`   | Export formats for documentation and sharing |

---

## 🧠 Contributing

If you're working on this repo:
- Keep `entities.json` as the structured source of truth.
- Do not manually edit `diagram.drawio` or `diagram.mmd` unless updating layouts or structure.
- When exporting, save to `output/` and **do not overwrite the original hand-drawn file** in `docs/`.

---

## 🔮 Future Enhancements

- [ ] Generate Mermaid diagrams from JSON
- [ ] Embed diagrams in internal documentation or website
- [ ] Version control for changes in business structure

---

## 📎 Reference

- Original diagram: [`docs/entity_diagram.pdf`](docs/entity_diagram.pdf)

---
