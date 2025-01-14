from django.urls import path
from . import views

urlpatterns = [
    path('', views.index, name='index'),
    path('api/rhino/solve/', views.solve_grasshopper, name='solve_grasshopper'),  # API

]
