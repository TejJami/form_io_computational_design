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

# load mapbox token from .env file
load_dotenv()

# Access the API key
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY_3")

# Initialize the OpenAI client
client = OpenAI(api_key=OPENAI_API_KEY)

# Field groups mapped to agent types
AGENT_INPUT_GROUPS = {
    "building": [
        "block",  # match any key starting with 'block'
    ],
    "envelope": [
        "envelope_"
    ],
    "facade": [
        "facade_"
    ]
}

# Prompt templates per agent
AGENT_PROMPT_GUIDANCE = {
    "building": "You are a building configuration assistant. Only respond with building-related inputs, like block height, units, floor count, corridor width, etc.",
    "envelope": "You are an envelope design assistant. You only deal with envelope parameters like setback, mode, vertices, etc.",
    "facade": "You are a facade design assistant. Handle only facade inputs like balcony types, widths, opening ratios, etc."
}


@csrf_exempt
def solve_grasshopper(request):
    if request.method == "POST":
        try:
            # 1. Collect Parameters
            gh_file_name = request.POST.get("grasshopper_file_name")
            inputs = json.loads(request.POST.get("input_data", "{}"))
            print("Inputs received:", inputs)

            # Locate Grasshopper definition
            gh_file_path = os.path.join(settings.GRASSHOPPER_FILES_DIR, gh_file_name)
            if not os.path.exists(gh_file_path):
                return JsonResponse({"success": False, "error": f"File {gh_file_name} not found."})

            # 2. Encode Grasshopper File
            with open(gh_file_path, "rb") as gh_file:
                gh_data = gh_file.read()
                encoded = base64.b64encode(gh_data).decode()  # Keep it as Base64-encoded string

            # 3. Prepare Inputs
            values = []
            for param_name, param_value in inputs.items():
                inner_tree = {
                    "{0;0}": [
                        {
                            "type": "System.Double" if isinstance(param_value, (float, int)) else "System.String",
                            "data": param_value,
                        }
                    ]
                }
                values.append({"ParamName": param_name, "InnerTree": inner_tree})

            # 4. Send Request to Rhino Compute
            post_url = "http://localhost:6001/grasshopper"
            payload = {"algo": encoded, "pointer": None, "values": values}
            response = requests.post(post_url, json=payload)

            # if response.status_code != 200:
            #     print("Compute server error:", response.text)
            #     return JsonResponse({"success": False, "error": response.text}, status=response.status_code)

            # 5. Parse and Return Result
            res_data = response.json()
            print("Response revieved from Rhino Compute")
            return JsonResponse(res_data)

        except Exception as e:
            print("Error in solve_grasshopper:", str(e))
            return JsonResponse({"success": False, "error": str(e)}, status=500)

    return JsonResponse({"success": False, "error": "Only POST method allowed."})

import re
import json
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from .models import Project  # Assuming you're using this
from openai import OpenAI

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

@csrf_exempt
def chat_with_openai(request):
    if request.method != 'POST':
        return JsonResponse({"error": "Invalid request method"}, status=400)

    try:
        body = json.loads(request.body)
        prompt = body.get("prompt", "").strip()
        if not prompt:
            return JsonResponse({"error": "Prompt cannot be empty."}, status=400)

        agent_type = route_prompt_to_agent(prompt)
        if not agent_type:
            return JsonResponse({"error": "Unable to classify prompt to an agent."}, status=400)

        valid_keys = sorted(list(VALID_INPUT_KEYS))

        # STEP 1 — Ask GPT to pick the best-matching key
        match_prompt = f"""
You are an assistant that maps user instructions to known architecture input keys.

Choose one exact parameter from the list below that best fits this user prompt:
{prompt}

Use ONLY this list of parameter names:
{valid_keys}

Respond like:
{{
  "match": "block2_width"
}}
"""

        match_response = client.chat.completions.create(
            model="gpt-4",
            messages=[
                {"role": "system", "content": "You respond only with JSON and only use known parameter names."},
                {"role": "user", "content": match_prompt}
            ],
            max_tokens=100
        )
        match_content = match_response.choices[0].message.content
        try:
            matched_key = json.loads(match_content).get("match")
        except Exception:
            return JsonResponse({"error": "Unable to extract match from OpenAI response."}, status=500)

        if matched_key not in VALID_INPUT_KEYS:
            return JsonResponse({"error": f"Matched key '{matched_key}' is not a valid parameter."}, status=400)

        # STEP 2 — Now ask GPT to change that one key based on the prompt
        update_prompt = f"""
Update the following parameter based on this prompt:

Prompt: {prompt}
Parameter to update: {matched_key}

Respond in this format:
{{
  "reasoning": "explains why the change was made",
  "parameters": {{
    "{matched_key}": new_value
  }}
}}
"""

        update_response = client.chat.completions.create(
            model="gpt-4",
            messages=[
                {"role": "system", "content": "You are an AI assistant for architecture parameters. Return only valid JSON."},
                {"role": "user", "content": update_prompt}
            ],
            max_tokens=300
        )

        update_content = update_response.choices[0].message.content
        parsed = parse_openai_response(update_content)

        if "error" in parsed:
            return JsonResponse(parsed, status=500)

        # Filter only exact keys
        updates = {
            k: clean_value(v)
            for k, v in parsed["parameters"].items()
            if k in VALID_INPUT_KEYS
        }

        return JsonResponse({
            "parameters": {
                "parameters": updates,
                "reasoning": parsed.get("reasoning", "")
            }
        })

    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)

def parse_openai_response(raw):
    try:
        data = json.loads(raw)
        return {
            "parameters": data.get("parameters", {}),
            "reasoning": data.get("reasoning", "")
        }
    except json.JSONDecodeError:
        return {"error": "Invalid JSON returned from OpenAI."}

def route_prompt_to_agent(prompt):
    lower = prompt.lower()
    print(f"[DEBUG] Routing prompt: {lower}")
    if any(term in lower for term in ["block", "units", "tower", "floor"]):
        return "building"
    if any(term in lower for term in ["setback", "envelope", "site"]):
        return "envelope"
    if any(term in lower for term in ["facade", "balcony", "shading"]):
        return "facade"
    return None


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

    mapbox_token = os.getenv("MAPBOX_PUBLIC_TOKEN")
    if not mapbox_token:
        print("Warning: MAPBOX_PUBLIC_TOKEN is not set in settings.")

    return render(request, "form_io/project_list.html", {
        "projects": projects,
        "mapbox_token": mapbox_token,
    })

def project_detail(request, project_id):
    project = get_object_or_404(Project, id=project_id)
    mapbox_token = os.getenv("MAPBOX_PUBLIC_TOKEN")
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
