from django.db import models
from django.utils import timezone

class Project(models.Model):
    PROJECT_TYPES = [
        ('residential', 'Residential Project'),
        ('acoustic', 'Acoustic Project'),
        ('urban', 'Urban Planning Project'),
    ]

    name = models.CharField(max_length=255, unique=True)
    type = models.CharField(max_length=50, choices=PROJECT_TYPES, default='residential')
    relative_location = models.JSONField(default=dict, blank=True) 
    site_bounds  = models.JSONField(default=dict, blank=True)  # stores drawn polygon/line
    site_envelope = models.JSONField(default=dict, blank=True)  # new field to store ordered polyline points

    inputs = models.JSONField(default=dict, blank=True)
    thumbnail = models.ImageField(upload_to='project_thumbnails/', null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name