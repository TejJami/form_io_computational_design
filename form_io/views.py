import requests
import base64
import json
import os
from django.http import JsonResponse
from django.conf import settings
from django.views.decorators.csrf import csrf_exempt
from django.shortcuts import render, redirect
from django.contrib.auth import authenticate, login, logout
from django.contrib.auth.decorators import login_required
from django.shortcuts import get_object_or_404
from openai import OpenAI
from dotenv import load_dotenv
import traceback
from .models import Project
from django.views.decorators.http import require_POST
import random
from sentence_transformers import SentenceTransformer
import faiss
import pickle
import traceback
import re
from django.core.cache import cache

# load mapbox token from .env file
load_dotenv()

# === Load FAISS index and docstore ===
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX_PATH = os.path.join(ROOT_DIR, "bauordnung_index.faiss")
DOCSTORE_PATH = os.path.join(ROOT_DIR, "bauordnung_chunks.pkl")

embedding_model = SentenceTransformer("sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
faiss_index = faiss.read_index(INDEX_PATH)

with open(DOCSTORE_PATH, "rb") as f:
    docstore = pickle.load(f)

# === OpenAI client ===
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY_4"))



def safe_json_parse(text):
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Try fixing single quotes → double quotes
        try:
            text = re.sub(r"'", '"', text)
            return json.loads(text)
        except Exception:
            return None

@csrf_exempt       
def chat_architecture_assistant(request):
    print("[INFO] Received request")

    if request.method != "POST":
        print("[ERROR] Invalid request method")
        return JsonResponse({"error": "Only POST allowed"}, status=405)

    try:
        body = json.loads(request.body)
        print(f"[INFO] Parsed body: {body}")

        user_prompt = body.get("prompt", "").strip()
        print(f"[INFO] User prompt: '{user_prompt}'")

        if not user_prompt:
            print("[ERROR] Prompt is empty")
            return JsonResponse({"error": "Prompt is empty"}, status=400)

        # === Step 1: Classify prompt intent ===
        print("[INFO] Classifying intent")
        intent_response = client.chat.completions.create(
            model="gpt-4",
            messages=[
                {"role": "system", "content": "You are a classifier that only responds with JSON: {'intent': 'query'} or {'intent': 'update'}."},
                {"role": "user", "content": f"Classify this prompt: {user_prompt}"}
            ],
            max_tokens=50
        )

        raw_intent = intent_response.choices[0].message.content
        print(f"[DEBUG] Raw intent response: {raw_intent}")

        intent_json = safe_json_parse(raw_intent)
        print(f"[DEBUG] Parsed intent JSON: {intent_json}")

        if not intent_json or "intent" not in intent_json:
            print(f"[INTENT PARSE ERROR] Got this from OpenAI: {raw_intent}")
            return JsonResponse({"error": "Malformed response from model"}, status=400)

        intent = intent_json.get("intent")
        print(f"[INFO] Detected intent: {intent}")

        if intent == "query":
            print("[INFO] Handling query intent")
            embedding = embedding_model.encode([user_prompt])
            print(f"[DEBUG] Computed embedding: {embedding}")

            D, I = faiss_index.search(embedding, k=3)
            print(f"[DEBUG] FAISS distances: {D}, indices: {I}")

            retrieved_chunks = [docstore[i] for i in I[0] if i < len(docstore)]
            print(f"[INFO] Retrieved documents: {retrieved_chunks}")

            # === Use GPT to answer based on retrieved chunks ===
            retrieval_prompt = f"""
        You are a helpful assistant for architecture and regulation guidance.
        Use the following context to answer the question clearly and directly.

        Context:
        {chr(10).join(retrieved_chunks)}

        Question:
        {user_prompt}

        Answer:
        """

            answer_response = client.chat.completions.create(
                model="gpt-4",
                messages=[
                    {"role": "system", "content": "You answer clearly and concisely based on provided context. If the answer is not fully clear, explain what is known and what would require clarification from another source. Do not just say 'not found' if something can be inferred."
},
                    {"role": "user", "content": retrieval_prompt}
                ],
                max_tokens=300
            )

            answer = answer_response.choices[0].message.content
            print(f"[INFO] Final GPT answer: {answer}")

            return JsonResponse({
                "intent": "query",
                "answer": answer,
                "sources": retrieved_chunks
            })


        elif intent == "update":
            print("[INFO] Handling update intent")
            valid_keys = sorted(list(VALID_INPUT_KEYS))
            print(f"[DEBUG] Valid input keys: {valid_keys}")

            match_prompt = f"""
            Match this prompt to the best parameter key from the following list:
            Prompt: "{user_prompt}"
            Keys: {valid_keys}
            Respond as: {{ "match": "..." }}
            """

            match_response = client.chat.completions.create(
                model="gpt-4",
                messages=[
                    {"role": "system", "content": "Return only JSON with 'match' key"},
                    {"role": "user", "content": match_prompt}
                ],
                max_tokens=100
            )
            print(f"[DEBUG] Match response: {match_response.choices[0].message.content}")
            match_key = json.loads(match_response.choices[0].message.content)["match"]

            if match_key not in VALID_INPUT_KEYS:
                print(f"[ERROR] Invalid matched key: {match_key}")
                return JsonResponse({"error": f"Invalid matched key: {match_key}"}, status=400)

            update_prompt = f"""
                The user gave this instruction: "{user_prompt}"
                The matched parameter key is: "{match_key}"

                Please return a response as JSON like:
                {{
                "reasoning": "Sure, I’ll set it to ...",
                "parameters": {{
                    "{match_key}": updated_value
                }}
                }}
                """


            update_response = client.chat.completions.create(
                model="gpt-4",
                messages=[
                    {"role": "system", "content": "Return valid JSON with parameter update."},
                    {"role": "user", "content": update_prompt}
                ],
                max_tokens=300
            )
            print(f"[DEBUG] Update response: {update_response.choices[0].message.content}")
            update_data = json.loads(update_response.choices[0].message.content)

            parameters = {
                k: clean_value(v) for k, v in update_data.get("parameters", {}).items() if k in VALID_INPUT_KEYS
            }

            print(f"[DEBUG] Matched key: {match_key}")
            print(f"[DEBUG] Update parameters: {parameters}")
            print(f"[DEBUG] Reasoning: {update_data.get('reasoning', '')}")

            return JsonResponse({
                "intent": "update",
                "parameters": parameters,
                "reasoning": update_data.get("reasoning", "")
            })

        else:
            print("[ERROR] Unknown intent value")
            return JsonResponse({"error": "Could not determine intent."}, status=400)

    except Exception as e:
        print("[ERROR]", traceback.format_exc())
        return JsonResponse({"error": str(e)}, status=500)


# @csrf_exempt
# def solve_grasshopper(request):
#     if request.method == "POST":
#         try:
#             # 1. Collect Parameters
#             gh_file_name = request.POST.get("grasshopper_file_name")
#             inputs = json.loads(request.POST.get("input_data", "{}"))
#             print("Inputs received:", inputs)

#             # Locate Grasshopper definition
#             gh_file_path = os.path.join(settings.GRASSHOPPER_FILES_DIR, gh_file_name)
#             if not os.path.exists(gh_file_path):
#                 return JsonResponse({"success": False, "error": f"File {gh_file_name} not found."})

#             # 2. Encode Grasshopper File
#             with open(gh_file_path, "rb") as gh_file:
#                 gh_data = gh_file.read()
#                 encoded = base64.b64encode(gh_data).decode()  # Keep it as Base64-encoded string

#             # 3. Prepare Inputs
#             values = []
#             for param_name, param_value in inputs.items():
#                 inner_tree = {
#                     "{0;0}": [
#                         {
#                             "type": "System.Double" if isinstance(param_value, (float, int)) else "System.String",
#                             "data": param_value,
#                         }
#                     ]
#                 }
#                 values.append({"ParamName": param_name, "InnerTree": inner_tree})

#             # 4. Send Request to Rhino Compute
#             post_url = "http://localhost:6001/grasshopper"
#             payload = {"algo": encoded, "pointer": None, "values": values}
#             response = requests.post(post_url, json=payload)


#             res_data = response.json()
#             print("Response revieved from Rhino Compute")
#             return JsonResponse(res_data)

#         except Exception as e:
#             print("Error in solve_grasshopper:", str(e))
#             return JsonResponse({"success": False, "error": str(e)}, status=500)

#     return JsonResponse({"success": False, "error": "Only POST method allowed."})




@csrf_exempt
def solve_grasshopper(request):
    if request.method == "POST":
        try:
            gh_file_name = request.POST.get("grasshopper_file_name")
            inputs = json.loads(request.POST.get("input_data", "{}"))
            print("Inputs received:", inputs)

            cache_key = compute_cache_key(gh_file_name, inputs)
            cached_result = cache.get(cache_key)

            if cached_result:
                print("[CACHE HIT]")
                return JsonResponse(cached_result)

            # === No cache, compute ===
            gh_file_path = os.path.join(settings.GRASSHOPPER_FILES_DIR, gh_file_name)
            if not os.path.exists(gh_file_path):
                return JsonResponse({"success": False, "error": f"File {gh_file_name} not found."})

            with open(gh_file_path, "rb") as gh_file:
                gh_data = gh_file.read()
                encoded = base64.b64encode(gh_data).decode()

            values = []
            for param_name, param_value in inputs.items():
                inner_tree = {
                    "{0;0}": [{
                        "type": "System.Double" if isinstance(param_value, (float, int)) else "System.String",
                        "data": param_value,
                    }]
                }
                values.append({"ParamName": param_name, "InnerTree": inner_tree})

            post_url = "http://localhost:6001/grasshopper"
            payload = {"algo": encoded, "pointer": None, "values": values}
            response = requests.post(post_url, json=payload)

            res_data = response.json()
            print("[CACHE STORE]")
            cache.set(cache_key, res_data, timeout=60 * 60)  # 1 hour cache (customize as needed)

            return JsonResponse(res_data)

        except Exception as e:
            print("Error in solve_grasshopper:", str(e))
            return JsonResponse({"success": False, "error": str(e)}, status=500)

    return JsonResponse({"success": False, "error": "Only POST method allowed."})





# Converts camelCase or PascalCase to snake_case (if needed elsewhere)
def normalize_key(key):
    return re.sub(r'(?<!^)(?=[A-Z])', '_', key).lower()

# Cleans values like "8 m" or "10m" → 8.0
def clean_value(val):
    if isinstance(val, str) and 'm' in val:
        try:
            return float(val.replace('m', '').strip())
        except ValueError:
            return val
    return val

# Define exactly allowed keys from your UI model (strict matching)
VALID_INPUT_KEYS = {
    "block1_NoOfUnits", "block1_corridor", "block1_floor_height", "block1_no_of_floors", "block1_width",
    "block2_NoOfUnits", "block2_corridor", "block2_floor_height", "block2_no_of_floors", "block2_type", "block2_width",
    "block3_NoOfUnits", "block3_corridor", "block3_floor_height", "block3_no_of_floors", "block3_type", "block3_width",
    "block4_NoOfUnits", "block4_floor_height", "block4_no_of_floors", "block4_type", "block4_width",
    "block5_NoOfUnits", "block5_floor_height", "block5_no_of_floors", "block5_type", "block5_width",
    "envelope_block_vertices", "envelope_mode", "envelope_setback", "envelope_vertices",
    "facade_block1_balconywidth", "facade_block1_balconytype",
    "facade_block2_balconywidth", "facade_block2_balconytype"
}

def parse_openai_response(raw):
    try:
        data = json.loads(raw)
        return {
            "parameters": data.get("parameters", {}),
            "reasoning": data.get("reasoning", "")
        }
    except json.JSONDecodeError:
        return {"error": "Invalid JSON returned from OpenAI."}


@csrf_exempt
def get_grasshopper_params(request):
    try:
        gh_file_name = request.GET.get("file")
        print(f"[INFO] Requested Grasshopper file: {gh_file_name}")

        if not gh_file_name:
            return JsonResponse({"error": "No file name provided"}, status=400)

        gh_path = os.path.join(settings.GRASSHOPPER_FILES_DIR, gh_file_name)
        if not os.path.exists(gh_path):
            return JsonResponse({"error": "File not found"}, status=404)

        with open(gh_path, "rb") as f:
            gh_bytes = f.read()
            encoded_gh = base64.b64encode(gh_bytes).decode("utf-8")

        payload = {
            "algo": encoded_gh,
            "pointer": None
        }

        compute_url = os.getenv("RHINO_COMPUTE_URL", "http://localhost:6001")
        post_url = f"{compute_url}/io"

        print(f"[INFO] Sending POST request to {post_url}")
        headers = {"Content-Type": "application/json"}
        response = requests.post(post_url, json=payload, headers=headers)

        if response.status_code != 200:
            print(f"[ERROR] Rhino Compute returned error: {response.status_code} - {response.text}")
            return JsonResponse({"error": response.text}, status=response.status_code)

        response_data = response.json()

        return JsonResponse(response_data)
    except Exception as e:
        print("[EXCEPTION] An error occurred during get_grasshopper_inputs:")
        traceback.print_exc()
        return JsonResponse({"error": str(e)}, status=500)

# Utility to get a random pastel background color
def get_random_pastel():
    pastel_colors = [
        "#fde2e2", "#e0f7fa", "#fff3e0", "#f1f8e9", "#e8eaf6",
        "#fce4ec", "#f9fbe7", "#ede7f6", "#e3f2fd", "#fbe9e7"
    ]
    return random.choice(pastel_colors)

# View to render the list of projects with pastel color backgrounds
def project_list(request):
    projects = Project.objects.all().order_by("-created_at")

    # Attach a random color attribute to each project (not persisted in DB)
    for project in projects:
        project.color = get_random_pastel()

    mapbox_token = settings.MAPBOX_PUBLIC_TOKEN
    if not mapbox_token:
        print("Warning: MAPBOX_PUBLIC_TOKEN is not set in settings.")

    return render(request, "form_io/project_list.html", {
        "projects": projects,
        "mapbox_token": mapbox_token,
    })

def project_detail(request, project_id):
    project = get_object_or_404(Project, id=project_id)
    mapbox_token = settings.MAPBOX_PUBLIC_TOKEN
    if not mapbox_token:
        print("Warning: MAPBOX_PUBLIC_TOKEN is not set in settings.")
            
    return render(request, "form_io/index.html", {
        "project": project,
        "project_inputs": json.dumps(project.inputs),
        "DJ_SITE_BOUNDS": json.dumps(project.site_bounds),
        "DJ_SITE_ENVELOPE": json.dumps(project.site_envelope),
        "mapbox_token": mapbox_token,
        "DJ_BLOCKS_ENVELOPE": json.dumps(project.blocks_envelope),
        "map_style": project.map_style
    })

@csrf_exempt
@require_POST
def api_create_project(request):
    try:
        data = json.loads(request.body)
        name = data.get("name")
        project_type = data.get("type")
        # location = data.get("location")
        site_bounds = data.get("site_bounds")

        if not name or not site_bounds:
            return JsonResponse({"error": "Missing name or site geometry"}, status=400)

        project = Project.objects.create(
            name=name,
            type=project_type,
            # location=location,
            site_bounds=site_bounds,
        )
        return JsonResponse({"success": True, "project_id": project.id})

    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)

@require_POST
def delete_project(request, project_id):
    project = get_object_or_404(Project, id=project_id)
    project.delete()
    return redirect('project_list')


@csrf_exempt
@require_POST
def save_project_inputs(request, project_id):
    project = get_object_or_404(Project, id=project_id)
    try:
        data = json.loads(request.body)
        print(f"Saving data for project {project_id}: {data}")


        # Save site_envelope if present
        if "site_envelope" in data:
            project.site_envelope = data["site_envelope"]

        # Save site_bounds if present
        if "site_bounds" in data:
            project.site_bounds = data["site_bounds"]

        # Save inputs if present
        if "inputs" in data:
            project.inputs = data["inputs"]

        # Save blocks if present
        if "blocks_envelope" in data:
            project.blocks_envelope = data["blocks_envelope"]

        if "map_style" in data:
            project.map_style = data["map_style"]

        project.save()
        return JsonResponse({"success": True})
    except Exception as e:
        return JsonResponse({"success": False, "error": str(e)}, status=400)

from django.http import JsonResponse, HttpResponseBadRequest

def get_project_polyline(request, project_id):
    try:
        project = Project.objects.get(pk=project_id)
        return JsonResponse({
            "DJ_SITE_ENVELOPE": project.site_envelope,
            "DJ_BLOCKS_ENVELOPE": project.blocks_envelope
        })
    except Project.DoesNotExist:
        return HttpResponseBadRequest("Invalid project ID")

import hashlib

def compute_cache_key(file_name, inputs):
    serialized = json.dumps({"file": file_name, "inputs": inputs}, sort_keys=True)
    return hashlib.md5(serialized.encode()).hexdigest()
