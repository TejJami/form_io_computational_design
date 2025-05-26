from django.urls import path
from . import views

urlpatterns = [
    path('', views.project_list, name='project_list'),
    path('projects/create/', views.create_project, name='create_project'),
    path('projects/<int:project_id>/', views.project_detail, name='project_detail'),
    path('api/rhino/solve/', views.solve_grasshopper, name='solve_grasshopper'),
    path('api/openai/chat/', views.chat_with_openai, name='chat_with_openai'),
    path('api/rhino/params/', views.get_grasshopper_params, name='get_grasshopper_params'),
    path('api/projects/<int:project_id>/save/', views.save_project_inputs, name='save_project_inputs'),
    path('api/projects/create/', views.api_create_project, name='api_create_project'),


]
