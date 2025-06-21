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

@csrf_exempt
def chat_with_openai(request):
    print("Received request for OpenAI call")
    if request.method == 'POST':
        try:
            # Parse the request body for the prompt
            data = json.loads(request.body)
            prompt = data.get('prompt', '')

            print(f"Received prompt: {prompt}")

            if not prompt:
                return JsonResponse({"error": "No prompt provided"}, status=400)

            # Define inputs, their descriptions, ranges, and an example response
            inputs_description = {
                "podium_length": "Defines the length of the podium, which is typically the base or foundation on which the main structure (e.g., towers or buildings) is built. This parameter determines how far the podium extends along one axis. Should always be more than 20000mm.",
                "podium_width": "Specifies the width of the podium, determining its dimension along the perpendicular axis to the length. Together with podium_length, this creates the footprint of the podium. Should always be more than 20000mm.",
                "podium_no_of_floors": "Sets the number of floors or levels in the podium. This parameter controls the vertical extent of the podium structure. Output is always an integer.",
                "floor_height": "Determines the height of each floor in the building. This is a crucial parameter for calculating the total height of the structure and maintaining proportions.",
                "building_type": "Indicates the type of building being designed. This must be an integer from 0 to 5, where each number represents a specific type: 0 for single tower, 1 for two towers, 2 for courtyard, 3 for staggered, 4 for L-shaped, and 5 for H-shaped. This parameter may influence other design aspects such as floor layout and building regulations.",
                "tower_num_floors": "Specifies the number of floors in the tower portion of the model, controlling its vertical scale. This is separate from the podium and applies to the taller sections of the design.",
                "courtyard_offset": "Controls the distance or spacing for the courtyard area, typically affecting how much open space is left between the building and the inner courtyard. This is only applicable if the building type is 2 (courtyard).",
                "staggered_offset": "Defines the offset distance for staggered elements of the design. This parameter is often used for creating a stepped or terraced effect in the facade or building form. This is applicable only if the building type is 3 (staggered).",
                "polyline_offset": "Specifies the separation or spacing between two towers in the design. This ensures appropriate distances are maintained for structural, aesthetic, or functional reasons, such as light, air circulation, and privacy. This is applicable only when the building type is 1 (two towers)."
            }


            input_ranges = {
                "podium_length": [10000, 200000],
                "podium_width": [10000, 100000],
                "podium_no_of_floors": [1, 20],
                "floor_height": [2000, 5000],
                "building_type": [0, 5],
                "tower_num_floors": [1, 50],
                "courtyard_offset": [0, 10000],
                "staggered_offset": [0, 3000],
                "polyline_offset": [0, 20000]
            }

            example_response = {
            "parameters": {
                "courtyard_offset": "1090.88", 
                "podium_lenght": "47025.3210000", 
                "floor_height": "4941.268", 
                "podium_no_of_floors": "12.418", 
                "tower_num_floors": "8.536", 
                "staggered_offset": "7862.917", 
                "building_type": "H-shaped ]", 
                "two_tower_offset": "0.22", 
                "podium_width": "37701.2450000", 
                "polyline_offset": "8537.49400000"
            }, 
            "reasoning": "Explain why you made these parameter choices"
            }


            # Combine all details into the prompt
            detailed_prompt = (
                "You are an architect specializing in housing projects. Based on the given inputs, "
                "select parameter values for a project. Here are the details:\n\n"
                "Inputs and Descriptions:\n" +
                "\n".join([f"- {key}: {desc}" for key, desc in inputs_description.items()]) +
                "\n\nInput Ranges:\n" +
                "\n".join([f"- {key}: {value}" for key, value in input_ranges.items()]) +
                "\n\nExample JSON Response:\n" +
                json.dumps(example_response, indent=4) +
                f"\n\nNow, based on the following prompt, provide parameter values as a JSON response and always include all the values that are there in the example json, if not applicable then it should be 0:\n{prompt}"
            )

            # Call the OpenAI API
            response = client.chat.completions.create(
                model="gpt-4",
                messages=[
                    {"role": "system", "content": "You are an expert architect specialized in housing project configurations.Always reply in JSON format as in the example json. Do not include any other information in the response."},
                    {"role": "user", "content": detailed_prompt},
                ],
                max_tokens=800
            )
            print("OpenAI API call succeeded")
            print(f"Raw OpenAI Response: {response}")

            # Extract the content and parse as JSON if applicable
            gpt_output = response.choices[0].message.content
            print(f"gpt output Response: {gpt_output}")

            # Use the parsing helper function
            parameters = parse_openai_response(gpt_output)

            # Handle errors in parsing
            if "error" in parameters:
                return JsonResponse(parameters, status=500)

            # Send the extracted parameters to the frontend
            return JsonResponse({"parameters": parameters})
            
        except Exception as e:
            print(f"Error while calling OpenAI API: {e}")
            return JsonResponse({"error": str(e)}, status=500)

    return JsonResponse({"error": "Invalid request method"}, status=400)

@csrf_exempt
def parse_openai_response(raw_response):
    """
    Parses the OpenAI JSON response to extract parameters and reasoning.
    """
    try:
        # Parse the JSON string
        parsed_response = json.loads(raw_response)

        # Extract "parameters" and "reasoning"
        parameters = parsed_response.get("parameters", {})
        reasoning = parsed_response.get("reasoning", "")

        # Return both as a dictionary
        return {"parameters": parameters, "reasoning": reasoning}
    except json.JSONDecodeError as e:
        print(f"Error parsing OpenAI JSON response: {e}")
        return {"error": "Invalid JSON format in OpenAI response."}

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
