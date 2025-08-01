import pickle
import faiss
import numpy as np
from sentence_transformers import SentenceTransformer

# Load cleaned chunks
with open("bauordnung_chunks.pkl", "rb") as f:
    chunks = pickle.load(f)

print(f"📄 Loaded {len(chunks)} chunks for indexing.")

# Use a multilingual sentence embedding model
model = SentenceTransformer("paraphrase-multilingual-MiniLM-L12-v2")

# Compute dense vector embeddings
print("🔍 Computing embeddings...")
embeddings = model.encode(
    chunks,
    convert_to_numpy=True,
    show_progress_bar=True
)

# Sanity check
assert len(embeddings) == len(chunks), "Mismatch between embeddings and chunks!"

# Save chunk-to-text map for future retrieval
chunk_map = {i: chunks[i] for i in range(len(chunks))}
with open("bauordnung_chunk_map.pkl", "wb") as f:
    pickle.dump(chunk_map, f)

# Build and save FAISS index
dimension = embeddings.shape[1]
index = faiss.IndexFlatL2(dimension)
index.add(embeddings)

faiss.write_index(index, "bauordnung_index.faiss")
print(f"✅ FAISS index saved with {len(chunks)} entries.")
