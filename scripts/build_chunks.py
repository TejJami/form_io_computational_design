import fitz  # PyMuPDF
import re
import pickle

def chunk_text(text):
    pattern = r"(§\s*\d+[a-zA-Z]?)"
    parts = re.split(pattern, text)
    chunks = []
    for i in range(1, len(parts), 2):
        heading = parts[i].strip()
        body = parts[i+1].strip() if i + 1 < len(parts) else ""
        full = f"{heading} {body}"
        if len(full) > 100:
            chunks.append(full)
    return chunks

doc = fitz.open("BauO_BE_2005.pdf")
all_text = "".join(page.get_text() for page in doc)
chunks = chunk_text(all_text)

with open("bauordnung_chunks.pkl", "wb") as f:
    pickle.dump(chunks, f)

print(f"✅ Extracted and saved {len(chunks)} chunks.")
