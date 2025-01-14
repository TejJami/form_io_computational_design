from django.urls import path
from . import views

urlpatterns = [
    path('', views.index, name='index'),
    path('api/rhino/solve/', views.solve_grasshopper, name='solve_grasshopper'),  # API
    path('api/openai/chat/', views.chat_with_openai, name='chat_with_openai'),
]
