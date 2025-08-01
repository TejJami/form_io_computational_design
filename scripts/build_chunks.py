import fitz  # PyMuPDF
import re
import pickle

def clean_text(text):
    # Fix broken line endings and normalize spacing
    text = re.sub(r"-\n", "", text)
    text = text.replace("\n", " ")
    text = re.sub(r"\s+", " ", text)
    return text.strip()

def chunk_text(text):
    # Split on § section markers (your original logic)
    pattern = r"(§\s*\d+[a-zA-Z]?)"
    parts = re.split(pattern, text)

    chunks = []
    for i in range(1, len(parts), 2):
        heading = parts[i].strip()
        body = parts[i + 1].strip() if i + 1 < len(parts) else ""
        full = clean_text(f"{heading} {body}")
        if len(full) > 100:
            chunks.append(full)
    return chunks

# Extract and process text
doc = fitz.open("BauO_BE_2005.pdf")
all_text = "".join(page.get_text() for page in doc)
chunks = chunk_text(all_text)

# Output
print(f"\n✅ Extracted and saved {len(chunks)} chunks.\n")
for i, chunk in enumerate(chunks[:3]):
    print(f"\n--- Chunk {i} ---\n{chunk[:500]}...\n")

# Save to file
with open("bauordnung_chunks.pkl", "wb") as f:
    pickle.dump(chunks, f)
