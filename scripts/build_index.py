# scripts/build_index.py

import pickle
import faiss
import numpy as np
from sentence_transformers import SentenceTransformer

# Load the previously saved chunks
with open("bauordnung_chunks.pkl", "rb") as f:
    chunks = pickle.load(f)

# Load a multilingual embedding model
model = SentenceTransformer("paraphrase-multilingual-MiniLM-L12-v2")

# Compute embeddings (vectors) for all chunks
print("🔍 Embedding chunks...")
embeddings = model.encode(chunks, convert_to_numpy=True)

# Save chunk-to-text map for retrieval
chunk_map = {i: chunks[i] for i in range(len(chunks))}
with open("bauordnung_chunk_map.pkl", "wb") as f:
    pickle.dump(chunk_map, f)

# Build FAISS index
dimension = embeddings.shape[1]
index = faiss.IndexFlatL2(dimension)
index.add(embeddings)
faiss.write_index(index, "bauordnung_index.faiss")

print(f"✅ Saved FAISS index with {len(chunks)} chunks.")
